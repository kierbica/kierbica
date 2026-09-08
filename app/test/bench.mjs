/**
 * Stage-level benchmark of the query engine at 1M rows.
 * node --experimental-strip-types test/bench.mjs
 */
import { synthesize } from '../src/worker/synth.ts';
import { runQuery } from '../src/worker/engine.ts';

const N = 1_000_000;
console.log(`generating ${N.toLocaleString()} rows…`);
const t0 = performance.now();
const wire = synthesize(N, 7, () => {});
console.log(`  synth: ${(performance.now() - t0).toFixed(0)}ms\n`);

const cols = wire.cols.map((c, i) => {
  const buf = wire.buffers[i];
  const data =
    c.kind === 'cat' ? new Uint32Array(buf)
    : c.kind === 'bool' ? new Uint8Array(buf)
    : new Float64Array(buf);
  return { ...c, data };
});
const table = { name: wire.name, nrows: N, cols, bytes: wire.bytes };
const idxOf = (n) => cols.findIndex((c) => c.name === n);

const base = {
  filters: [], sort: null, group: null, aggs: [], histCol: null, groupLimit: 200,
};

const run = (label, spec, reps = 5) => {
  let best = Infinity;
  let last;
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    last = runQuery(table, { ...base, ...spec }, i);
    best = Math.min(best, performance.now() - t);
  }
  const s = last.stats;
  console.log(
    `${label.padEnd(34)} ${best.toFixed(1).padStart(7)}ms   ` +
    `filter ${s.filterMs.toFixed(1)}  sort ${s.sortMs.toFixed(1)}  group ${s.groupMs.toFixed(1)}   ` +
    `→ ${last.matched.toLocaleString()} rows`,
  );
  return best;
};

console.log('stage                                    best      breakdown');
console.log('─'.repeat(104));
run('scan (no filter, no sort)', {});
run('sort by revenue desc', { sort: { col: idxOf('revenue'), dir: -1 } });
run('sort by revenue asc', { sort: { col: idxOf('revenue'), dir: 1 } });
run('sort by rating (4.5% nulls)', { sort: { col: idxOf('rating'), dir: -1 } });
run('sort by region (categorical)', { sort: { col: idxOf('region'), dir: 1 } });
run('range filter on revenue', {
  filters: [{ id: 'a', col: idxOf('revenue'), op: 'range', lo: 100, hi: 5000, enabled: true }],
});
run('3 stacked filters', {
  filters: [
    { id: 'a', col: idxOf('revenue'), op: 'range', lo: 50, hi: 9000, enabled: true },
    { id: 'b', col: idxOf('region'), op: 'in', set: [0, 1, 2], enabled: true },
    { id: 'c', col: idxOf('margin'), op: 'range', lo: 0.1, hi: 0.9, enabled: true },
  ],
});
run('group by region + sum revenue', {
  group: { col: idxOf('region'), bins: 24 },
  aggs: [{ col: idxOf('revenue'), fn: 'sum' }],
});
run('group by country (25) + avg', {
  group: { col: idxOf('country'), bins: 24 },
  aggs: [{ col: idxOf('revenue'), fn: 'avg' }],
});
run('group by date into 48 bins', {
  group: { col: idxOf('order_ts'), bins: 48 },
  aggs: [{ col: idxOf('revenue'), fn: 'sum' }],
});
run('group + median (worst case)', {
  group: { col: idxOf('region'), bins: 24 },
  aggs: [{ col: idxOf('revenue'), fn: 'median' }],
});
run('histogram only', { histCol: idxOf('revenue') });
run('FULL: filter+sort+group+hist', {
  filters: [{ id: 'a', col: idxOf('revenue'), op: 'range', lo: 50, hi: 9000, enabled: true }],
  sort: { col: idxOf('revenue'), dir: -1 },
  group: { col: idxOf('category'), bins: 24 },
  aggs: [{ col: idxOf('revenue'), fn: 'sum' }],
  histCol: idxOf('revenue'),
});
console.log('─'.repeat(104));
