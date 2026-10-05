// Loads a FICTIONAL signage-company example (explicit opt-in: `npm run db:seed`). No real data. Safe to skip: new users start with an empty workspace.
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ ...process.env, WORKER_MODE: 'off', LOG_LEVEL: 'silent', RATE_LIMIT_ANON_PER_MIN: '100000', RATE_LIMIT_TOKEN_PER_MIN: '100000' } as NodeJS.ProcessEnv);
const { fastify, ctx } = await buildApp(config);
const password = process.env.SEED_PASSWORD ?? randomBytes(9).toString('base64url');
const email = process.env.SEED_EMAIL ?? 'demo@example.test';

let cookie = '', csrf = '';
async function call(method: string, url: string, body?: unknown) {
  const r = await fastify.inject({ method: method as any, url, headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), 'content-type': 'application/json' }, payload: body === undefined ? undefined : JSON.stringify(body) });
  const set = ([] as string[]).concat((r.headers['set-cookie'] as any) ?? []);
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const j = r.body ? JSON.parse(r.body) : null;
  if (r.statusCode >= 400) throw new Error(`${method} ${url} -> ${r.statusCode} ${r.body}`);
  return j;
}

const exists = await ctx.db.owner.query(`SELECT 1 FROM users WHERE lower(email)=$1`, [email]);
if (exists.rowCount) { console.log(`${email} already exists; not seeding again.`); process.exit(0); }
const su = await call('POST', '/api/v1/auth/signup', { email, name: 'Demo Owner', password, workspace_name: 'Demo Signage Co (fictional)' });
csrf = su.csrf_token;
const ws = su.workspaces[0].id;
const base = (await call('POST', `/api/v1/workspaces/${ws}/bases`, { name: 'Signage projects (fictional demo)' })).id;

const customers = await call('POST', `/api/v1/bases/${base}/tables`, { name: 'Customers', fields: [
  { name: 'Company', type: 'text' }, { name: 'Contact email', type: 'email' }, { name: 'Phone', type: 'phone' }, { name: 'Website', type: 'url' },
  { name: 'Tier', type: 'single_select', options: { options: ['Standard', 'Preferred', 'Enterprise'] } }] });
const cf = Object.fromEntries(customers.fields.map((f: any) => [f.name, f.id]));
const projects = await call('POST', `/api/v1/bases/${base}/tables`, { name: 'Projects', fields: [
  { name: 'Project', type: 'text' }, { name: 'Customer', type: 'text' },
  { name: 'Status', type: 'single_select', options: { options: ['Quote', 'Approved', 'In production', 'Installed', 'Invoiced'] } },
  { name: 'Sign types', type: 'multi_select', options: { options: ['LED channel letters', 'Neon', 'Vinyl wrap', 'Monument', 'Window graphics'] } },
  { name: 'Quote total', type: 'currency', options: { currency: 'USD' } }, { name: 'Deposit %', type: 'percent', options: { scale: 1, min: '0', max: '100' } },
  { name: 'Quantity', type: 'integer', options: { min: 0 } }, { name: 'Install date', type: 'date' },
  { name: 'Site visit', type: 'datetime', options: { timezone: 'America/New_York' } }, { name: 'Permit filed', type: 'checkbox' },
  { name: 'Notes', type: 'long_text' }, { name: 'Artwork', type: 'attachment' }, { name: 'Created', type: 'created_time' }, { name: 'Last modified', type: 'modified_time' }] });
const pf = Object.fromEntries(projects.fields.map((f: any) => [f.name, f.id]));

const names = ['Harbor Bakery', 'Northside Dental', 'Maple Street Hardware', 'Blue Heron Café', 'Summit Fitness', 'Orchard Pharmacy', 'Redwood Realty', 'Lantern Books', 'Granite Bank (demo)', 'Sunrise Auto Care'];
const tiers = ['Standard', 'Preferred', 'Enterprise'];
await call('POST', `/api/v1/tables/${customers.id}/records`, { records: names.map((n, i) => ({ fields: { [cf.Company]: n, [cf['Contact email']]: `office${i}@example.test`, [cf.Phone]: `+1555010${String(i).padStart(4, '0')}`, [cf.Website]: `https://example.test/${i}`, [cf.Tier]: tiers[i % 3] } })) });
const statuses = ['Quote', 'Approved', 'In production', 'Installed', 'Invoiced'], types = ['LED channel letters', 'Neon', 'Vinyl wrap', 'Monument', 'Window graphics'];
const recs = Array.from({ length: 60 }, (_, i) => ({ fields: {
  [pf.Project]: `${names[i % names.length]} — ${types[i % 5]} #${i + 1}`, [pf.Customer]: names[i % names.length],
  [pf.Status]: statuses[i % 5], [pf['Sign types']]: [types[i % 5], types[(i + 2) % 5]], [pf['Quote total']]: `${1200 + i * 137}.${String((i * 7) % 100).padStart(2, '0')}`,
  [pf['Deposit %']]: i % 4 === 0 ? '50' : '25.5', [pf.Quantity]: (i % 6) + 1, [pf['Install date']]: `2026-${String((i % 9) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
  [pf['Site visit']]: `2026-${String((i % 9) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}T10:30:00`, [pf['Permit filed']]: i % 3 === 0 ? true : i % 3 === 1 ? false : undefined,
  [pf.Notes]: i % 5 === 0 ? 'Needs lift truck.\nConfirm electrical.' : undefined } }));
for (let i = 0; i < recs.length; i += 50) await call('POST', `/api/v1/tables/${projects.id}/records`, { records: recs.slice(i, i + 50) });

await call('POST', `/api/v1/tables/${projects.id}/views`, { name: 'Pipeline board', type: 'kanban', visibility: 'shared', config: { kanban: { groupField: pf.Status, cardFields: [pf.Customer, pf['Quote total']] } } });
await call('POST', `/api/v1/tables/${projects.id}/views`, { name: 'Install calendar', type: 'calendar', visibility: 'shared', config: { calendar: { dateField: pf['Install date'], titleField: pf.Project } } });
await call('POST', `/api/v1/tables/${projects.id}/views`, { name: 'Gallery', type: 'gallery', visibility: 'shared', config: { gallery: { titleField: pf.Project, coverField: pf.Artwork, cardFields: [pf.Status, pf['Quote total']] } } });
await call('POST', `/api/v1/tables/${projects.id}/views`, { name: 'Big quotes', type: 'grid', visibility: 'shared', config: { filter: { field: pf['Quote total'], op: 'gte', value: '3000' }, sort: [{ field: pf['Quote total'], direction: 'desc' }] } });
await call('POST', `/api/v1/tables/${projects.id}/views`, { name: 'Request a quote', type: 'form', visibility: 'shared', config: { form: { title: 'Request a quote', description: 'Fictional intake form', fields: [{ field: pf.Project, required: true }, { field: pf.Customer, required: true }, { field: pf['Sign types'] }, { field: pf.Notes }] } } });
await call('POST', `/api/v1/tables/${projects.id}/automations`, { name: 'New projects start as Quote', trigger: { type: 'record_created' }, actions: [{ type: 'update_record', fields: { [pf.Status]: 'Quote' } }] });

console.log(`Seeded fictional demo data.\n  email:    ${email}\n  password: ${password}\n  (shown once; set SEED_PASSWORD to choose your own)`);
await fastify.close(); await ctx.db.close();
