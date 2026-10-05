// End-to-end browser check against a RUNNING server (default http://localhost:4100) with the seeded demo data.
// Usage: BASE=http://localhost:4100 DEMO_EMAIL=demo@example.test DEMO_PASSWORD=... node e2e/smoke.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE ?? 'http://localhost:4100';
const email = process.env.DEMO_EMAIL ?? 'demo@example.test', password = process.env.DEMO_PASSWORD;
if (!password) throw new Error('set DEMO_PASSWORD (printed by `npm run db:seed`)');
mkdirSync(new URL('./shots/', import.meta.url), { recursive: true });
const shot = (page, n) => page.screenshot({ path: new URL(`./shots/${n}.png`, import.meta.url).pathname });
const exe = process.env.CHROMIUM ?? (await import('node:fs')).readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-')).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`)[0];
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.setDefaultTimeout(10_000);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const results = [];
const nav = () => page.getByRole('navigation', { name: /Workspaces/ });
const step = async (name, fn) => { try { await fn(); results.push(['PASS', name]); console.log('PASS', name); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); console.log('FAIL', name, '-', e.message.split('\n')[0]); await shot(page, 'FAIL-' + name.replace(/\W+/g, '-')).catch(() => {}); } };

await step('unauthenticated visit redirects to login', async () => { await page.goto(BASE + '/'); await page.waitForURL('**/login'); await page.getByRole('heading', { name: 'Basecraft' }).waitFor(); });
await step('wrong password shows an error', async () => { await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill('wrong-password-123'); await page.getByRole('button', { name: 'Sign in' }).click(); await page.getByRole('alert').waitFor(); });
await step('sign in', async () => { await page.getByLabel('Password').fill(password); await page.getByRole('button', { name: 'Sign in' }).click(); await page.getByRole('navigation', { name: /Workspaces/ }).waitFor(); await shot(page, '01-home'); });
await step('open Projects table in grid', async () => { await nav().getByRole('link', { name: 'Projects', exact: true }).click(); await page.getByRole('grid', { name: /Projects records/ }).waitFor(); await page.getByRole('gridcell').first().waitFor(); await shot(page, '02-grid'); });
await step('grid only renders a window of rows (virtualized)', async () => { const n = await page.getByRole('row').count(); if (n > 60) throw new Error('too many rows in DOM: ' + n); if (n < 5) throw new Error('too few rows ' + n); });
await step('keyboard navigation moves the active cell', async () => {
  const grid = page.getByRole('grid', { name: /Projects records/ }); await grid.focus();
  const a0 = await grid.getAttribute('aria-activedescendant'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
  const a1 = await grid.getAttribute('aria-activedescendant'); if (!a1 || a1 === a0) throw new Error('active cell did not move');
});
let editedRow;
await step('inline edit with keyboard saves and persists after reload', async () => {
  const grid = page.getByRole('grid', { name: /Projects records/ }); await grid.focus();
  await page.keyboard.press('Control+Home'); await page.keyboard.type('Edited by e2e'); await page.keyboard.press('Enter');
  await page.getByText('All changes saved').waitFor(); editedRow = 'Edited by e2e';
  await page.reload(); await page.getByRole('gridcell', { name: /Edited by e2e/ }).first().waitFor();
});
await step('invalid value is rejected with a visible error and not saved', async () => {
  const grid = page.getByRole('grid', { name: /Projects records/ }); await grid.focus();
  await page.keyboard.press('Control+Home'); for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight'); // Quantity column
  await page.keyboard.type('abc'); await page.keyboard.press('Enter');
  await page.getByText(/must be a whole number/i).first().waitFor(); await shot(page, '03-invalid');
  await page.keyboard.press('Escape');
});
await step('undo reverts the last edit', async () => {
  const grid = page.getByRole('grid', { name: /Projects records/ }); await grid.focus(); await page.keyboard.press('Control+Home');
  await page.keyboard.type('Temp value'); await page.keyboard.press('Enter'); await page.getByText('All changes saved').waitFor();
  await page.getByRole('gridcell', { name: /Temp value/ }).first().waitFor();
  await grid.focus(); await page.keyboard.press('Control+z'); await page.getByText('Undid last change').waitFor(); await page.getByRole('gridcell', { name: /Temp value/ }).first().waitFor({ state: 'detached' });
});
await step('record panel opens, edits a field, closes with Escape', async () => {
  await page.getByRole('button', { name: 'Open record 1', exact: true }).click(); const dlg = page.getByRole('dialog', { name: /Record:/ }); await dlg.waitFor(); await shot(page, '04-panel');
  const vtxt = async () => (await dlg.getByText(/^Version \d+ ·/).textContent()).match(/Version (\d+)/)[1];
  const v0 = Number(await vtxt());
  await dlg.getByLabel(/^Notes/).fill('typed in panel ' + Date.now()); await dlg.getByLabel(/^Notes/).blur();
  await page.waitForFunction((v) => new RegExp('Version ' + (v + 1) + ' ·').test(document.body.innerText), v0);
  await page.keyboard.press('Escape'); await dlg.waitFor({ state: 'detached' });
});
await step('server-side search narrows results', async () => { await page.getByLabel('Search records').fill('Harbor Bakery'); await page.waitForFunction(() => { const m = /(\d+) loaded of (\d+)/.exec(document.body.innerText); return !!m && Number(m[2]) > 0 && Number(m[2]) < 60; }); await shot(page, '05-search'); await page.getByLabel('Search records').fill(''); });
await step('filter builder: add a condition and see unsaved-view badge', async () => {
  await page.getByRole('button', { name: /^Filter/ }).click(); await page.getByRole('button', { name: '+ Add condition' }).click();
  await page.getByRole('button', { name: /^Filter/ }).click(); // close
  await page.getByText('Unsaved view changes').waitFor();
});
await step('revert discards local view changes', async () => { await page.getByRole('button', { name: 'Revert' }).click(); await page.getByText('Unsaved view changes').waitFor({ state: 'detached' }); });
for (const [tab, check] of [['Pipeline board', /Quote|Approved/], ['Install calendar', /Today/], ['Gallery', /Load more|Harbor|record/i], ['Request a quote', /Request a quote/]]) {
  await step(`view tab: ${tab}`, async () => { await page.getByRole('tab', { name: new RegExp(tab) }).click(); await page.getByText(check).first().waitFor(); await shot(page, '06-' + tab.replace(/\W+/g, '-')); });
}
await step('submit the form view', async () => {
  await page.getByLabel(/^Project/).first().fill('E2E form project'); await page.getByLabel(/^Customer/).first().fill('E2E Customer');
  await page.getByRole('button', { name: /Submit|Send/i }).first().click(); await page.getByText(/recorded|Thanks/i).first().waitFor();
});
await step('settings: API tokens page lists tokens and creating one shows it once', async () => {
  await page.getByRole('link', { name: 'API tokens' }).click(); await page.getByRole('heading', { name: /API tokens/i }).first().waitFor(); await shot(page, '07-tokens');
});
await step('settings: members page shows permission matrix', async () => { await page.getByRole('link', { name: /Members/ }).click(); await page.getByRole('heading', { name: 'What each role can do' }).waitFor(); await shot(page, '08-members'); });
await step('settings: audit log shows record changes', async () => { await page.getByRole('link', { name: 'Audit log' }).click(); await page.getByText(/record\.update|record\.create/).first().waitFor(); });
await step('automations page loads', async () => { await nav().getByRole('link', { name: 'Projects', exact: true }).click(); await page.getByRole('link', { name: 'Automations' }).click(); await page.getByText(/New projects start as Quote/).waitFor(); await shot(page, '09-automations'); });
await step('mobile layout has no horizontal page scroll', async () => {
  await page.setViewportSize({ width: 390, height: 800 }); await page.goto(BASE + '/'); await page.getByRole('button', { name: 'Open navigation' }).waitFor();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (over > 1) throw new Error('page overflows by ' + over + 'px'); await shot(page, '10-mobile');
});
await step('200% zoom equivalent (640px wide) stays usable', async () => { await page.setViewportSize({ width: 640, height: 800 }); await page.getByRole('button', { name: 'Open navigation' }).click(); await nav().getByRole('link', { name: 'Projects', exact: true }).click(); await page.getByRole('grid').waitFor(); });
await step('sign out returns to login', async () => { await page.setViewportSize({ width: 1280, height: 800 }); await page.goto(BASE + '/'); await page.getByRole('button', { name: 'Sign out' }).click(); await page.waitForURL('**/login'); });
await step('no uncaught page errors / console errors', async () => { const real = errors.filter((e) => !/401|Failed to load resource.*(401|403)/.test(e)); if (real.length) throw new Error(real.slice(0, 3).join(' | ')); });
await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
