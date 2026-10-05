import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

/** Blob storage port. Local disk is the development adapter; an S3-compatible adapter implements the same interface (see docs/architecture.md). */
export interface BlobStore {
  put(key: string, data: Readable, maxBytes: number): Promise<{ size: number; sha256: string; head: Buffer }>;
  get(key: string): Readable;
  delete(key: string): Promise<void>;
  /** Keys older than `olderThanMs` (for stray-file sweeps). */
  list(prefix: string, olderThanMs: number): AsyncGenerator<string>;
}

export class SizeLimitError extends Error {}

export class LocalStore implements BlobStore {
  private root: string;
  constructor(dir: string) { this.root = resolve(dir); mkdirSync(this.root, { recursive: true }); }

  private path(key: string): string {
    // keys are server-generated "<workspace-uuid>/<uuid>"; still defend against traversal
    if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)) throw new Error('bad storage key');
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('bad storage key');
    return p;
  }

  async put(key: string, data: Readable, maxBytes: number) {
    const dest = this.path(key);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomUUID()}.part`;
    const hash = createHash('sha256');
    let size = 0;
    const chunks: Buffer[] = [];
    let headLen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new SizeLimitError('File too large'));
        hash.update(chunk);
        if (headLen < 4096) { chunks.push(chunk.subarray(0, 4096 - headLen)); headLen += Math.min(chunk.length, 4096 - headLen); }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(data, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      await rename(tmp, dest);
    } catch (e) { await rm(tmp, { force: true }); throw e; }
    return { size, sha256: hash.digest('hex'), head: Buffer.concat(chunks) };
  }
  get(key: string) { return createReadStream(this.path(key)); }
  async delete(key: string) { await rm(this.path(key), { force: true }); }
  async *list(prefix: string, olderThanMs: number) {
    const base = join(this.root, prefix);
    if (!existsSync(base)) return;
    for (const ws of readdirSync(this.root)) {
      const d = join(this.root, ws);
      if (!statSync(d).isDirectory()) continue;
      for (const f of readdirSync(d)) {
        if (f.endsWith('.part')) continue;
        if (Date.now() - statSync(join(d, f)).mtimeMs > olderThanMs) yield `${ws}/${f}`;
      }
    }
  }
}

// ───────── content policy ─────────
const BLOCKED_EXT = new Set(['html', 'htm', 'xhtml', 'svg', 'svgz', 'js', 'mjs', 'cjs', 'jsx', 'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'sh', 'bash', 'ps1', 'vbs', 'jar', 'php', 'phtml', 'py', 'rb', 'pl', 'hta', 'lnk', 'xml', 'xsl', 'swf', 'apk', 'app', 'dmg', 'iso']);
const ZIP_BASED = new Set(['docx', 'xlsx', 'pptx', 'zip']);
const TEXTY: Record<string, string> = { txt: 'text/plain', csv: 'text/csv', json: 'application/json', md: 'text/markdown' };

export interface Verdict { ok: true; contentType: string; filename: string } 
export interface Rejection { ok: false; reason: string }

/** Decide whether to accept an upload. The detected type — not the client-declared one — is what gets stored. */
export function checkUpload(rawName: string, head: Buffer): Verdict | Rejection {
  const filename = sanitizeFilename(rawName);
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  if (BLOCKED_EXT.has(ext)) return { ok: false, reason: `.${ext} files can contain active content and are not allowed` };
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return { ok: false, reason: 'Executable files are not allowed' };
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return { ok: false, reason: 'Executable files are not allowed' };
  if (head.subarray(0, 2).toString('latin1') === '#!') return { ok: false, reason: 'Scripts are not allowed' };
  const sniff = sniffBinary(head);
  const txt = head.toString('utf8', 0, 512).trimStart().toLowerCase();
  if (/^<(!doctype|html|script|svg|\?xml|iframe)/.test(txt)) return { ok: false, reason: 'HTML/SVG/XML content is not allowed' };
  if (sniff) {
    const okExt = sniff.exts.includes(ext) || (sniff.type === 'application/zip' && ZIP_BASED.has(ext));
    if (!okExt) return { ok: false, reason: `File contents (${sniff.type}) do not match the .${ext || '?'} extension` };
    return { ok: true, contentType: ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : ext === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : sniff.type, filename };
  }
  if (TEXTY[ext]) {
    if (head.includes(0)) return { ok: false, reason: 'Binary data in a text file' };
    return { ok: true, contentType: TEXTY[ext]!, filename };
  }
  return { ok: false, reason: `Unsupported file type${ext ? ` (.${ext})` : ''}. Allowed: images, PDF, Office documents, zip, txt, csv, json` };
}

function sniffBinary(h: Buffer): { type: string; exts: string[] } | null {
  const is = (...b: number[]) => b.every((x, i) => h[i] === x);
  if (is(0x89, 0x50, 0x4e, 0x47)) return { type: 'image/png', exts: ['png'] };
  if (is(0xff, 0xd8, 0xff)) return { type: 'image/jpeg', exts: ['jpg', 'jpeg'] };
  if (h.subarray(0, 4).toString('latin1') === 'GIF8') return { type: 'image/gif', exts: ['gif'] };
  if (h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP') return { type: 'image/webp', exts: ['webp'] };
  if (h.subarray(0, 5).toString('latin1') === '%PDF-') return { type: 'application/pdf', exts: ['pdf'] };
  if (is(0x50, 0x4b, 0x03, 0x04)) return { type: 'application/zip', exts: ['zip', 'docx', 'xlsx', 'pptx'] };
  return null;
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const clean = base.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
  return clean || 'file';
}

/** Pluggable malware scanning port. The default accepts everything that passed the type policy; wire ClamAV/ICAP here before opening uploads to untrusted users. */
export interface Scanner { scan(key: string, store: BlobStore): Promise<'clean' | 'rejected'> }
export const noopScanner: Scanner = { async scan() { return 'clean'; } };

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}
