// Browser memory profile on the large benchmark table: scrolls through thousands of rows and records the JS heap (after forced GC),
// DOM size and the number of rows the grid holds, to show memory stays bounded by cached pages, not by table size.
// Usage: BASE=http://localhost:4101 BENCH_EMAIL=… BENCH_PASSWORD=… node e2e/memory.mjs   (writes ../bench/raw/browser-memory.json)
import { chromium } from 'playwright-core';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
const BASE = process.env.BASE ?? 'http://localhost:4101';
const exe = process.env.CHROMIUM ?? readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-')).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`)[0];
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(20_000);
await page.goto(BASE + '/login');
await page.getByLabel('Email').fill(process.env.BENCH_EMAIL); await page.getByLabel('Password').fill(process.env.BENCH_PASSWORD);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByRole('link', { name: 'Bench 100k', exact: true }).first().click();
const grid = page.getByRole('grid', { name: /Bench 100k records/ }); await grid.waitFor();
await page.getByRole('gridcell').first().waitFor();
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
const sample = async (label) => {
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  const m = await page.evaluate(() => ({ domNodes: document.getElementsByTagName('*').length, renderedRows: document.querySelectorAll('[role=row]').length, status: (document.body.innerText.match(/[\d,]+ loaded of [\d,]+\+?/) ?? [''])[0] }));
  return { label, heapMB: +(heap / 2 ** 20).toFixed(1), ...m };
};
const out = [await sample('initial')];
const steps = Number(process.env.STEPS ?? 60);
for (let i = 1; i <= steps; i++) {
  await page.evaluate(() => { const el = document.querySelector('.grid-scroll'); el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(350);
  if (i % 10 === 0) { out.push(await sample(`after ${i} scroll-to-bottom steps`)); console.log(out.at(-1)); }
}
// scroll back to the top: dropped pages must be refetched via prev_cursor
let backSteps = 0;
for (; backSteps < 200; backSteps++) {
  await page.evaluate(() => { document.querySelector('.grid-scroll').scrollTop = 0; }); await page.waitForTimeout(250);
  const t = await page.getByRole('gridcell').first().innerText().catch(() => '');
  if (/ sign 0\b/.test(t)) break;
}
console.log('steps to get back to the first record:', backSteps);
out.push(await sample('after scrolling back to top')); console.log(out.at(-1));
const first = await page.getByRole('gridcell').first().innerText().catch(() => '');
mkdirSync(new URL('../../bench/raw/', import.meta.url), { recursive: true });
writeFileSync(new URL('../../bench/raw/browser-memory.json', import.meta.url), JSON.stringify({ when: new Date().toISOString(), chromium: browser.version(), table: '100,000 records x 20 fields', steps, stepsBackToTop: backSteps, samples: out, firstCellAfterReturn: first }, null, 2));
await browser.close();
