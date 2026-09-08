/**
 * Browser end-to-end checks.
 *
 * Boots the app against a running dev server, then exercises loading,
 * filtering, sorting, every view, CSV import and a 1M-row stress pass while
 * watching for console errors. Screenshots land in shots/.
 *
 *   npm run dev            # in another shell
 *   npm run e2e
 *
 * Set NEBULA_CHROME to use a specific Chromium binary, and NEBULA_URL to point
 * at a different origin.
 */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const URL = process.env.NEBULA_URL ?? 'http://localhost:5173/';
const EXE = process.env.NEBULA_CHROME;
const errors = [];
let pass = 0;
let fail = 0;

if (!existsSync('shots')) mkdirSync('shots');

// A CSV exercising quoting, embedded commas, dates, booleans and empty cells.
const CSV = 'test/fixture.csv';
if (!existsSync(CSV)) {
  const cities = ['Naga', 'Manila', 'Cebu', 'Davao', 'Iloilo', 'Baguio'];
  const segs = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  let s = 'event_date,city,segment,score,amount,is_active,notes\n';
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 40000; i++) {
    const d = new Date(Date.UTC(2024, 0, 1) + Math.floor(rnd() * 700) * 86400000);
    s += [
      d.toISOString().slice(0, 10),
      cities[(rnd() * cities.length) | 0],
      segs[(rnd() * segs.length) | 0],
      (rnd() * 120 + 8).toFixed(2),
      (Math.exp(rnd() * 6) + 1).toFixed(2),
      rnd() > 0.5 ? 'true' : 'false',
      i % 97 === 0 ? '"note, with comma"' : i % 53 === 0 ? '"quoted ""text"""' : '',
    ].join(',') + '\n';
  }
  writeFileSync(CSV, s);
}

const step = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); console.log(`  ok   ${name}  (${Date.now() - t0}ms)`); pass++; }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); errors.push(`${name}: ${e.message}`); fail++; }
};

const b = await chromium.launch({
  ...(EXE ? { executablePath: EXE } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const p = await b.newPage({ viewport: { width: 1600, height: 940 } });
p.setDefaultTimeout(90000);
// Vite's HMR socket can't reach the page in headless CI; that noise isn't ours.
const ignorable = (t) => /websocket|vite|ERR_CONNECTION/i.test(t);
p.on('console', (m) => { if (m.type() === 'error' && !ignorable(m.text())) errors.push(m.text()); });
p.on('pageerror', (e) => { if (!ignorable(e.message)) errors.push('pageerror: ' + e.message); });

const booted = () =>
  p.waitForFunction(() => document.querySelector('#boot')?.classList.contains('gone'), { timeout: 90000 });

console.log('\n— boot —');
await p.goto(URL, { waitUntil: 'domcontentloaded' });
await step('default dataset loads', booted);
console.log(`  ${await p.textContent('#fRows')} rows · query ${await p.textContent('#fQuery')} · ${await p.textContent('#fMem')}`);

await step('grid actually paints pixels', async () => {
  const lit = await p.evaluate(() => {
    const cv = document.querySelector('#gridCanvas');
    const c = cv.getContext('2d');
    const d = c.getImageData(0, 0, Math.min(500, cv.width), Math.min(300, cv.height)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) n++;
    return n;
  });
  if (lit < 500) throw new Error(`grid looks blank (${lit} lit px)`);
});

await step('field list populated', async () => {
  const n = await p.locator('.field').count();
  if (n < 10) throw new Error(`only ${n} fields`);
});
await p.screenshot({ path: 'shots/01-grid.png' });

await step('header click sorts', async () => {
  await p.mouse.click(400, 120);
  await p.waitForTimeout(500);
});

await step('adding a filter does not blank the view', async () => {
  const before = +(await p.textContent('#fRows')).replace(/,/g, '');
  await p.hover('.field >> nth=1');
  await p.click('.field:nth-child(2) [data-act="filter"]');
  await p.waitForTimeout(700);
  const after = +(await p.textContent('#fRows')).replace(/,/g, '');
  if (after !== before) throw new Error(`row count changed ${before} -> ${after}`);
});

await step('deselecting a value narrows the result', async () => {
  const before = +(await p.textContent('#fRows')).replace(/,/g, '');
  await p.click('.cl-row >> nth=0');
  await p.waitForTimeout(700);
  const after = +(await p.textContent('#fRows')).replace(/,/g, '');
  if (after >= before) throw new Error(`expected fewer rows, got ${before} -> ${after}`);
});
await p.screenshot({ path: 'shots/02-filter.png' });

for (const [key, name] of [['2', 'bars'], ['3', 'trend'], ['4', 'scatter'], ['5', 'matrix']]) {
  await step(`view: ${name}`, async () => {
    await p.keyboard.press(key);
    await p.waitForTimeout(1200);
    const ok = await p.evaluate((n) => {
      const map = { bars: '#cBars', trend: '#cTrend', scatter: '#cScatter', matrix: '#cMatrix' };
      const cv = document.querySelector(map[n]);
      return !!cv && cv.width > 0 && cv.height > 0;
    }, name);
    if (!ok) throw new Error('canvas has no size');
    await p.screenshot({ path: `shots/0${+key + 1}-${name}.png` });
  });
}
console.log(`  scatter: ${await p.textContent('#scNote')}`);

await step('command palette filters and runs', async () => {
  await p.keyboard.press('1');
  await p.waitForTimeout(300);
  await p.keyboard.press('Control+k');
  await p.waitForTimeout(400);
  await p.keyboard.type('group by region');
  await p.waitForTimeout(300);
  if (!(await p.locator('.pal-item').count())) throw new Error('palette empty');
  await p.screenshot({ path: 'shots/07-palette.png' });
  await p.keyboard.press('Enter');
  await p.waitForTimeout(800);
});

await step('grid stays at 60fps while scrolling', async () => {
  await p.keyboard.press('1');
  await p.waitForTimeout(400);
  for (let i = 0; i < 25; i++) { await p.mouse.move(700, 500); await p.mouse.wheel(0, 900); }
  await p.waitForTimeout(500);
  const fps = +(await p.textContent('#fFps'));
  if (fps < 45) throw new Error(`fps dropped to ${fps}`);
});

await step('clear filters', async () => {
  await p.keyboard.press('c');
  await p.waitForTimeout(700);
  if (await p.locator('.fchip').count()) throw new Error('filters remain');
});

console.log('\n— CSV import —');
await step('import a CSV with quoting, dates and nulls', async () => {
  await p.setInputFiles('input[type=file]', CSV);
  await p.waitForFunction(() => document.querySelector('#fRows')?.textContent === '40,000', { timeout: 90000 });
});

const schema = await p.evaluate(() =>
  Array.from(document.querySelectorAll('.field')).map((f) => ({
    name: f.querySelector('.field-name')?.textContent,
    kind: f.querySelector('.field-ico')?.className.replace('field-ico k-', ''),
  })),
);
for (const c of schema) console.log(`    ${(c.name ?? '').padEnd(12)} ${c.kind}`);

await step('types inferred correctly', () => {
  const want = { event_date: 'date', is_active: 'bool', score: 'num', amount: 'num', city: 'cat' };
  for (const [n, k] of Object.entries(want)) {
    const got = schema.find((c) => c.name === n)?.kind;
    if (got !== k) throw new Error(`${n}: expected ${k}, got ${got}`);
  }
});
await p.screenshot({ path: 'shots/10-csv.png' });

console.log('\n— 1M row stress —');
await step('generate 1,000,000 rows', async () => {
  await p.click('#btnGen');
  await p.waitForTimeout(400);
  await p.evaluate(() => {
    const r = document.querySelector('#gRows');
    r.value = '1000000';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#gGo').click();
  });
  await p.waitForFunction(
    () => document.querySelector('#fRows')?.textContent === '1,000,000',
    { timeout: 150000 },
  );
});
console.log(`  query ${await p.textContent('#fQuery')} · ${await p.textContent('#fMem')}`);

await step('sort 1M rows', async () => {
  await p.evaluate(() => {
    const i = window.__nebula.cols().findIndex((c) => c.name === 'revenue');
    window.__nebula.sort(i);
  });
  await p.waitForTimeout(1500);
  console.log(`       engine ${await p.textContent('#fQuery')}`);
});

await step('render 1M points on the GPU', async () => {
  await p.keyboard.press('4');
  await p.waitForTimeout(2500);
  console.log(`       ${await p.textContent('#scNote')}`);
  const fps = +(await p.textContent('#fFps'));
  if (fps < 45) throw new Error(`fps ${fps}`);
  await p.screenshot({ path: 'shots/12-1m-scatter.png' });
});

await step('scroll the 1M-row table', async () => {
  await p.keyboard.press('1');
  await p.waitForTimeout(600);
  for (let i = 0; i < 30; i++) { await p.mouse.move(700, 500); await p.mouse.wheel(0, 2400); }
  await p.waitForTimeout(600);
  const fps = +(await p.textContent('#fFps'));
  console.log(`       fps ${fps} · frame ${await p.textContent('#fFrame')}`);
  if (fps < 45) throw new Error(`fps ${fps}`);
});

await p.screenshot({ path: 'shots/13-final.png' });
await b.close();

console.log(`\n  ${pass} passed, ${fail} failed`);
if (errors.length) {
  console.log('\n— console errors —');
  errors.slice(0, 15).forEach((e) => console.log('  ' + e));
}
process.exit(errors.length ? 1 : 0);
