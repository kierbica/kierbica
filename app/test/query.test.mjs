/**
 * End-to-end engine tests: filtering, grouping and aggregation are checked
 * against naive reference implementations computed independently.
 *
 * node --experimental-strip-types --import ./test/register.mjs test/query.test.mjs
 */
import assert from 'node:assert/strict';
import { runQuery } from '../src/worker/engine.ts';
import { synthesize } from '../src/worker/synth.ts';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const close = (a, b, eps = 1e-6) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

const N = 120_000;
const wire = synthesize(N, 42, () => {});
const cols = wire.cols.map((c, i) => {
  const buf = wire.buffers[i];
  const data =
    c.kind === 'cat' ? new Uint32Array(buf)
    : c.kind === 'bool' ? new Uint8Array(buf)
    : new Float64Array(buf);
  return { ...c, data };
});
const table = { name: 'test', nrows: N, cols, bytes: wire.bytes };
const ix = (n) => cols.findIndex((c) => c.name === n);
const base = { filters: [], sort: null, group: null, aggs: [], histCol: null, groupLimit: 500 };
const q = (spec) => runQuery(table, { ...base, ...spec }, 1);

const REV = ix('revenue');
const REGION = ix('region');
const RATING = ix('rating');
const RETURNED = ix('returned');

console.log(`\ndataset: ${N.toLocaleString()} rows, ${cols.length} cols\n`);

// ------------------------------------------------------------------ filters
t('no filter returns every row exactly once', () => {
  const r = q({});
  assert.equal(r.matched, N);
  const seen = new Uint8Array(N);
  for (let i = 0; i < r.matched; i++) seen[r.index[i]] = 1;
  assert.equal(seen.reduce((a, b) => a + b, 0), N);
});

t('range filter matches a manual scan', () => {
  const lo = 200;
  const hi = 1500;
  const d = cols[REV].data;
  let want = 0;
  for (let i = 0; i < N; i++) if (d[i] >= lo && d[i] <= hi) want++;
  const r = q({ filters: [{ id: 'a', col: REV, op: 'range', lo, hi, enabled: true }] });
  assert.equal(r.matched, want);
  for (let i = 0; i < r.matched; i++) {
    const v = d[r.index[i]];
    assert.ok(v >= lo && v <= hi, `row ${r.index[i]} = ${v} outside [${lo},${hi}]`);
  }
});

t('range filter excludes NaN (null) values', () => {
  const d = cols[RATING].data;
  const r = q({ filters: [{ id: 'a', col: RATING, op: 'range', lo: -1e9, hi: 1e9, enabled: true }] });
  let nonNull = 0;
  for (let i = 0; i < N; i++) if (!Number.isNaN(d[i])) nonNull++;
  assert.equal(r.matched, nonNull);
});

t('`in` filter selects exactly the chosen codes', () => {
  const set = [0, 2];
  const d = cols[REGION].data;
  let want = 0;
  for (let i = 0; i < N; i++) if (set.includes(d[i])) want++;
  const r = q({ filters: [{ id: 'a', col: REGION, op: 'in', set, enabled: true }] });
  assert.equal(r.matched, want);
});

t('empty `in` set matches nothing', () => {
  const r = q({ filters: [{ id: 'a', col: REGION, op: 'in', set: [], enabled: true }] });
  assert.equal(r.matched, 0);
});

t('disabled filters are ignored', () => {
  const r = q({ filters: [{ id: 'a', col: REGION, op: 'in', set: [], enabled: false }] });
  assert.equal(r.matched, N);
});

t('stacked filters compose as AND', () => {
  const dr = cols[REV].data;
  const dg = cols[REGION].data;
  let want = 0;
  for (let i = 0; i < N; i++) if (dr[i] >= 100 && dr[i] <= 900 && (dg[i] === 1 || dg[i] === 3)) want++;
  const r = q({
    filters: [
      { id: 'a', col: REV, op: 'range', lo: 100, hi: 900, enabled: true },
      { id: 'b', col: REGION, op: 'in', set: [1, 3], enabled: true },
    ],
  });
  assert.equal(r.matched, want);
});

t('boolean filter works', () => {
  const d = cols[RETURNED].data;
  let want = 0;
  for (let i = 0; i < N; i++) if (d[i] === 1) want++;
  const r = q({ filters: [{ id: 'a', col: RETURNED, op: 'in', set: [1], enabled: true }] });
  assert.equal(r.matched, want);
});

// ------------------------------------------------------------------ sorting
t('descending sort is the reverse of ascending', () => {
  const asc = q({ sort: { col: REV, dir: 1 } });
  const desc = q({ sort: { col: REV, dir: -1 } });
  const d = cols[REV].data;
  for (let i = 1; i < asc.matched; i++) assert.ok(d[asc.index[i - 1]] <= d[asc.index[i]]);
  for (let i = 1; i < desc.matched; i++) assert.ok(d[desc.index[i - 1]] >= d[desc.index[i]]);
});

t('sorting a column with nulls keeps them last in both directions', () => {
  const d = cols[RATING].data;
  for (const dir of [1, -1]) {
    const r = q({ sort: { col: RATING, dir } });
    let firstNull = r.matched;
    for (let i = 0; i < r.matched; i++) {
      if (Number.isNaN(d[r.index[i]])) { firstNull = i; break; }
    }
    for (let i = firstNull; i < r.matched; i++) {
      assert.ok(Number.isNaN(d[r.index[i]]), `dir=${dir}: non-null after nulls at ${i}`);
    }
  }
});

t('sort + filter keeps both invariants', () => {
  const d = cols[REV].data;
  const r = q({
    filters: [{ id: 'a', col: REV, op: 'range', lo: 300, hi: 3000, enabled: true }],
    sort: { col: REV, dir: -1 },
  });
  for (let i = 0; i < r.matched; i++) {
    const v = d[r.index[i]];
    assert.ok(v >= 300 && v <= 3000);
    if (i) assert.ok(d[r.index[i - 1]] >= v);
  }
});

// -------------------------------------------------------------- aggregation
t('group counts sum to the matched total', () => {
  const r = q({ group: { col: REGION, bins: 24 }, aggs: [{ col: REV, fn: 'sum' }] });
  let total = 0;
  for (let i = 0; i < r.groups.count.length; i++) total += r.groups.count[i];
  assert.equal(total, r.matched);
});

t('sum aggregate matches a manual per-group sum', () => {
  const r = q({ group: { col: REGION, bins: 24 }, aggs: [{ col: REV, fn: 'sum' }] });
  const dg = cols[REGION].data;
  const dv = cols[REV].data;
  const want = new Map();
  for (let i = 0; i < N; i++) want.set(dg[i], (want.get(dg[i]) ?? 0) + dv[i]);
  for (let i = 0; i < r.groups.labels.length; i++) {
    const key = r.groups.keys[i];
    assert.ok(close(r.groups.values[0][i], want.get(key), 1e-9),
      `group ${r.groups.labels[i]}: ${r.groups.values[0][i]} vs ${want.get(key)}`);
  }
});

t('avg aggregate matches sum/count', () => {
  const s = q({ group: { col: REGION, bins: 24 }, aggs: [{ col: REV, fn: 'sum' }] });
  const a = q({ group: { col: REGION, bins: 24 }, aggs: [{ col: REV, fn: 'avg' }] });
  for (let i = 0; i < a.groups.labels.length; i++) {
    assert.ok(close(a.groups.values[0][i], s.groups.values[0][i] / s.groups.count[i], 1e-9));
  }
});

t('min/max aggregates are correct', () => {
  const r = q({
    group: { col: REGION, bins: 24 },
    aggs: [{ col: REV, fn: 'min' }, { col: REV, fn: 'max' }],
  });
  const dg = cols[REGION].data;
  const dv = cols[REV].data;
  const mn = new Map();
  const mx = new Map();
  for (let i = 0; i < N; i++) {
    mn.set(dg[i], Math.min(mn.get(dg[i]) ?? Infinity, dv[i]));
    mx.set(dg[i], Math.max(mx.get(dg[i]) ?? -Infinity, dv[i]));
  }
  for (let i = 0; i < r.groups.labels.length; i++) {
    const k = r.groups.keys[i];
    assert.ok(close(r.groups.values[0][i], mn.get(k)), 'min');
    assert.ok(close(r.groups.values[1][i], mx.get(k)), 'max');
  }
});

t('median aggregate matches a sorted reference', () => {
  const r = q({ group: { col: REGION, bins: 24 }, aggs: [{ col: REV, fn: 'median' }] });
  const dg = cols[REGION].data;
  const dv = cols[REV].data;
  const buckets = new Map();
  for (let i = 0; i < N; i++) {
    if (!buckets.has(dg[i])) buckets.set(dg[i], []);
    buckets.get(dg[i]).push(dv[i]);
  }
  for (let i = 0; i < r.groups.labels.length; i++) {
    const arr = buckets.get(r.groups.keys[i]).sort((a, b) => a - b);
    assert.ok(close(r.groups.values[0][i], arr[arr.length >> 1]),
      `${r.groups.labels[i]}: ${r.groups.values[0][i]} vs ${arr[arr.length >> 1]}`);
  }
});

t('aggregates ignore null values but counts include them', () => {
  const r = q({ group: { col: REGION, bins: 24 }, aggs: [{ col: RATING, fn: 'count' }] });
  const dg = cols[REGION].data;
  const dr = cols[RATING].data;
  const all = new Map();
  const nonNull = new Map();
  for (let i = 0; i < N; i++) {
    all.set(dg[i], (all.get(dg[i]) ?? 0) + 1);
    if (!Number.isNaN(dr[i])) nonNull.set(dg[i], (nonNull.get(dg[i]) ?? 0) + 1);
  }
  for (let i = 0; i < r.groups.labels.length; i++) {
    const k = r.groups.keys[i];
    assert.equal(r.groups.count[i], all.get(k), 'row count');
    assert.equal(r.groups.values[0][i], nonNull.get(k), 'non-null count');
  }
});

t('binned numeric grouping covers the full range', () => {
  const r = q({ group: { col: REV, bins: 20 }, aggs: [{ col: REV, fn: 'sum' }] });
  let total = 0;
  for (let i = 0; i < r.groups.count.length; i++) total += r.groups.count[i];
  assert.equal(total, N);
});

t('grouping respects active filters', () => {
  const r = q({
    filters: [{ id: 'a', col: REGION, op: 'in', set: [0], enabled: true }],
    group: { col: REGION, bins: 24 },
    aggs: [{ col: REV, fn: 'sum' }],
  });
  assert.equal(r.groups.labels.length, 1);
  assert.equal(r.groups.count[0], r.matched);
});

// ------------------------------------------------------------------ histogram
t('histogram bins sum to the matched count (minus nulls)', () => {
  const r = q({ histCol: REV });
  let total = 0;
  for (let i = 0; i < r.hist.bins.length; i++) total += r.hist.bins[i];
  assert.equal(total, r.matched);
});

t('histogram reflects filters', () => {
  const r = q({
    filters: [{ id: 'a', col: REV, op: 'range', lo: 500, hi: 1000, enabled: true }],
    histCol: REV,
  });
  let total = 0;
  for (let i = 0; i < r.hist.bins.length; i++) total += r.hist.bins[i];
  assert.equal(total, r.matched);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
