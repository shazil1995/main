// Custom CRM → Basecraft idempotent upsert by stable external id. Run: BASECRAFT_TOKEN=bc_... TABLE_ID=<uuid> npx tsx crm-upsert.ts
// Contract: the target table has a text field named "External ID" (unique by convention) plus the mapped fields below.
// This example performs REAL WRITES to the table you point it at. It does not talk to any external CRM.
const BASE = process.env.BASECRAFT_URL ?? 'http://localhost:4100', TOKEN = process.env.BASECRAFT_TOKEN!, TABLE = process.env.TABLE_ID!;
const h = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra });
const api = async (m: string, p: string, b?: unknown, x: Record<string, string> = {}) => { const r = await fetch(`${BASE}/api/v1${p}`, { method: m, headers: h(x), body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); if (!r.ok) throw new Error(`${m} ${p} ${r.status} ${t}`); return t ? JSON.parse(t) : null; };

interface CrmContact { id: string; name: string; email?: string; phone?: string }       // shape your CRM sends/webhooks
const incoming: CrmContact[] = [{ id: 'crm-1001', name: 'Ada Lovelace', email: 'ada@example.test' }, { id: 'crm-1002', name: 'Grace Hopper', phone: '+15550100' }];

const table = await api('GET', `/tables/${TABLE}`);
const fid = (n: string) => { const f = table.fields.find((x: any) => x.name === n); if (!f) throw new Error(`missing field "${n}"`); return f.id as string; };
const map = (c: CrmContact) => ({ [fid('External ID')]: c.id, [table.fields.find((f: any) => f.is_primary).id]: c.name, ...(c.email && table.fields.some((f: any) => f.name === 'Email') ? { [fid('Email')]: c.email } : {}) });

for (const c of incoming) {
  const found = await api('POST', `/tables/${TABLE}/records/query`, { filter: { field: fid('External ID'), op: 'eq', value: c.id }, limit: 2 });
  if (found.records.length > 1) throw new Error(`duplicate external id ${c.id}: reconcile manually`);
  if (found.records.length === 0) { const r = await api('POST', `/tables/${TABLE}/records`, { fields: map(c) }, { 'idempotency-key': `crm-create-${c.id}` }); console.log('created', c.id, r.id); }
  else { const r = found.records[0]; const u = await api('PATCH', `/records/${r.id}`, { fields: map(c) }, { 'if-match': `"${r.version}"` }); console.log('upserted', c.id, 'v' + u.version); }   // 412 => someone edited meanwhile: re-read and re-apply per your conflict policy
}
