/**
 * Correctness + performance tests for the query engine.
 *
 * Run with:  node --experimental-strip-types test/engine.test.mjs
 * These import the real .ts sources; Node 22 strips the types natively.
 */
import assert from 'node:assert/strict';
import { sortFloatIndex, sortCodeIndex, quickselect } from '../src/worker/sort.ts';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const rand = (seed) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// ------------------------------------------------------------------ sorting
t('sortFloatIndex matches Array#sort on random doubles', () => {
  const r = rand(1);
  const n = 50000;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = (r() - 0.5) * 1e9;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  sortFloatIndex(v, idx, n);
  for (let i = 1; i < n; i++) {
    assert.ok(v[idx[i - 1]] <= v[idx[i]], `out of order at ${i}`);
  }
});

t('handles negatives, zeros and subnormals', () => {
  const v = Float64Array.from([0, -0, 1, -1, 5e-324, -5e-324, 1e308, -1e308, 0.1, -0.1]);
  const n = v.length;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  sortFloatIndex(v, idx, n);
  const got = Array.from(idx, (i) => v[i]);
  const want = Array.from(v).sort((a, b) => a - b);
  for (let i = 0; i < n; i++) assert.equal(Object.is(got[i], -0) ? 0 : got[i], Object.is(want[i], -0) ? 0 : want[i]);
});

t('large array (1M) stays ordered', () => {
  const r = rand(9);
  const n = 1_000_000;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = r() * 1e6;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const t0 = performance.now();
  sortFloatIndex(v, idx, n);
  const ms = performance.now() - t0;
  for (let i = 1; i < n; i++) assert.ok(v[idx[i - 1]] <= v[idx[i]]);
  console.log(`       1M radix sort: ${ms.toFixed(0)}ms`);
});

t('constant column is a no-op but still ordered', () => {
  const n = 5000;
  const v = new Float64Array(n).fill(42);
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  sortFloatIndex(v, idx, n);
  assert.equal(idx.length, n);
  for (let i = 1; i < n; i++) assert.ok(v[idx[i - 1]] <= v[idx[i]]);
});

t('small arrays take the comparator path correctly', () => {
  const v = Float64Array.from([3, 1, 2]);
  const idx = Uint32Array.from([0, 1, 2]);
  sortFloatIndex(v, idx, 3);
  assert.deepEqual(Array.from(idx), [1, 2, 0]);
});

t('sortCodeIndex groups by code and pins nulls last', () => {
  const NULL = 0xffffffff;
  const v = Uint32Array.from([2, 0, NULL, 1, 1, 0, NULL, 2]);
  const idx = new Uint32Array(v.length);
  for (let i = 0; i < v.length; i++) idx[i] = i;
  sortCodeIndex(v, idx, v.length, 3, NULL);
  const codes = Array.from(idx, (i) => v[i]);
  const nonNull = codes.filter((c) => c !== NULL);
  for (let i = 1; i < nonNull.length; i++) assert.ok(nonNull[i - 1] <= nonNull[i]);
  assert.equal(codes[codes.length - 1], NULL);
  assert.equal(codes[codes.length - 2], NULL);
});

// ------------------------------------------------------------------ select
t('quickselect finds the median', () => {
  const r = rand(3);
  for (const n of [1, 2, 7, 100, 4001]) {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = r() * 1000;
    const want = Array.from(a).sort((x, y) => x - y)[n >> 1];
    const got = quickselect(Float64Array.from(a), n, n >> 1);
    assert.equal(got, want, `n=${n}`);
  }
});

// ------------------------------------------------------------------ perf gate
t('1M sort completes under 400ms', () => {
  const r = rand(5);
  const n = 1_000_000;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = r() * 1e9;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const t0 = performance.now();
  sortFloatIndex(v, idx, n);
  const ms = performance.now() - t0;
  console.log(`       measured: ${ms.toFixed(0)}ms`);
  assert.ok(ms < 400, `too slow: ${ms.toFixed(0)}ms`);
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
