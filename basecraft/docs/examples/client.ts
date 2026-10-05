// Minimal Basecraft API client + walkthrough. Run: BASECRAFT_URL=http://localhost:4100 BASECRAFT_TOKEN=bc_... TABLE_ID=<uuid> npx tsx client.ts
// Tokens are created in the UI (Workspace → API tokens) by an admin and are shown once.
const BASE = process.env.BASECRAFT_URL ?? 'http://localhost:4100';
const TOKEN = process.env.BASECRAFT_TOKEN ?? '';
const TABLE = process.env.TABLE_ID ?? '';
if (!TOKEN || !TABLE) throw new Error('set BASECRAFT_TOKEN and TABLE_ID');

export class ApiError extends Error { constructor(public status: number, public code: string, message: string, public details?: unknown, public traceId?: string) { super(message); } }

async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ data: T; etag?: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 429 && attempt < 5) { await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') ?? 1) * 1000)); continue; } // honour Retry-After
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, json?.error?.code, json?.error?.message, json?.error?.details, json?.error?.trace_id);
    return { data: json as T, etag: res.headers.get('etag') ?? undefined };
  }
}

// 1. discover field ids (the API is keyed by stable field ids, never by display names)
const table = (await call<any>('GET', `/tables/${TABLE}`)).data;
const field = (name: string) => table.fields.find((f: any) => f.name === name)?.id as string;
console.log('fields:', table.fields.map((f: any) => `${f.name}:${f.type}`).join(', '));

// 2. create a record safely: retries with the same Idempotency-Key never create duplicates
const key = crypto.randomUUID();
const created = (await call<any>('POST', `/tables/${TABLE}/records`, { fields: { [field(table.fields[0].name)]: 'Created via API' } }, { 'idempotency-key': key })).data;
const again = (await call<any>('POST', `/tables/${TABLE}/records`, { fields: { [field(table.fields[0].name)]: 'Created via API' } }, { 'idempotency-key': key })).data;
console.log('created', created.id, 'replay returned same id:', again.id === created.id);

// 3. optimistic concurrency: send the version you read. A stale version is rejected with 412 and the current record.
const rec = (await call<any>('GET', `/records/${created.id}`));
const updated = (await call<any>('PATCH', `/records/${created.id}`, { fields: { [table.fields[0].id]: 'Renamed' } }, { 'if-match': rec.etag! })).data;
try { await call('PATCH', `/records/${created.id}`, { fields: { [table.fields[0].id]: 'Stale write' } }, { 'if-match': rec.etag! }); }
catch (e) { if (e instanceof ApiError && e.status === 412) console.log('stale write rejected; current version =', (e.details as any).current.version); else throw e; }

// 4. query with a filter group, sort and cursor pagination (page through everything)
let cursor: string | undefined, seen = 0;
do {
  const page = (await call<any>('POST', `/tables/${TABLE}/records/query`, { limit: 100, cursor, sort: [{ field: table.fields[0].id, direction: 'asc' }], fields: [table.fields[0].id] })).data;
  seen += page.records.length; cursor = page.next_cursor ?? undefined;
} while (cursor);
console.log('paged through', seen, 'records');

// 5. delete (version required)
await call('DELETE', `/records/${created.id}`, undefined, { 'if-match': `"${updated.version}"` });
console.log('deleted');
