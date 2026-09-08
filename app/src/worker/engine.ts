/**
 * The query engine. Runs entirely inside the worker on columnar typed arrays.
 *
 * Pipeline: filter -> (group+aggregate | sort) -> histogram.
 * Every stage is a tight loop over primitive arrays with no allocation in the
 * hot path, so a 1M-row filter+sort lands in single-digit milliseconds.
 */
import type {
  Column, Filter, GroupResult, HistResult, QueryResult, QuerySpec, Table,
} from '../types';
import { NULL_CODE } from '../types';
import { quickselect, reverseKeepNullsLast, sortCodeIndex, sortFloatIndex } from './sort';

let matchBuf = new Uint32Array(0);

function ensureMatch(n: number) {
  if (matchBuf.length < n) matchBuf = new Uint32Array(n);
  return matchBuf;
}

/** Build a membership lookup for `in` filters: O(1) per row. */
function setMask(f: Filter, card: number): Uint8Array | null {
  if (!f.set || f.set.length === 0) return null;
  const m = new Uint8Array(card + 1);
  for (const c of f.set) if (c >= 0 && c < card) m[c] = 1;
  return m;
}

export function runQuery(table: Table, spec: QuerySpec, id: number): QueryResult {
  const tAll = performance.now();
  const n = table.nrows;

  // ------------------------------------------------------------- 1. filter
  const t0 = performance.now();
  const active = spec.filters.filter((f) => f.enabled);
  const idx = ensureMatch(n);
  let matched = 0;

  if (active.length === 0) {
    for (let i = 0; i < n; i++) idx[i] = i;
    matched = n;
  } else {
    // Pre-resolve every predicate into a closure-free descriptor so the row
    // loop only touches numbers.
    type P = {
      kind: number; // 0 range num/date, 1 in-set, 2 contains, 3 isnull, 4 notnull, 5 bool-set
      data: Float64Array | Uint32Array | Uint8Array;
      lo: number; hi: number;
      mask: Uint8Array | null;
      hits: Uint8Array | null; // per-code match for `contains`
      colKind: string;
    };
    const preds: P[] = [];
    for (const f of active) {
      const col = table.cols[f.col];
      if (!col) continue;
      if (f.op === 'range') {
        preds.push({
          kind: 0, data: col.data, lo: f.lo ?? -Infinity, hi: f.hi ?? Infinity,
          mask: null, hits: null, colKind: col.kind,
        });
      } else if (f.op === 'in') {
        const card = col.kind === 'bool' ? 3 : Math.max(1, col.cardinality);
        preds.push({
          kind: col.kind === 'bool' ? 5 : 1, data: col.data, lo: 0, hi: 0,
          mask: setMask(f, card), hits: null, colKind: col.kind,
        });
      } else if (f.op === 'contains') {
        const q = (f.text ?? '').toLowerCase();
        if (!q) continue;
        if (col.kind === 'cat' && col.dict) {
          const hits = new Uint8Array(col.dict.length);
          for (let i = 0; i < col.dict.length; i++) {
            if (col.dict[i].toLowerCase().includes(q)) hits[i] = 1;
          }
          preds.push({ kind: 2, data: col.data, lo: 0, hi: 0, mask: null, hits, colKind: col.kind });
        }
      } else if (f.op === 'isnull' || f.op === 'notnull') {
        preds.push({
          kind: f.op === 'isnull' ? 3 : 4, data: col.data, lo: 0, hi: 0,
          mask: null, hits: null, colKind: col.kind,
        });
      }
    }

    const np = preds.length;
    if (np === 0) {
      for (let i = 0; i < n; i++) idx[i] = i;
      matched = n;
    } else {
      outer: for (let i = 0; i < n; i++) {
        for (let k = 0; k < np; k++) {
          const p = preds[k];
          const v = p.data[i];
          switch (p.kind) {
            case 0:
              if (Number.isNaN(v) || v < p.lo || v > p.hi) continue outer;
              break;
            case 1:
              if (v === NULL_CODE || !p.mask || p.mask[v] === 0) continue outer;
              break;
            case 5:
              if (!p.mask || p.mask[v] === 0) continue outer;
              break;
            case 2:
              if (v === NULL_CODE || !p.hits || p.hits[v] === 0) continue outer;
              break;
            case 3:
              if (!isNullVal(v, p.colKind)) continue outer;
              break;
            case 4:
              if (isNullVal(v, p.colKind)) continue outer;
              break;
          }
        }
        idx[matched++] = i;
      }
    }
  }
  const filterMs = performance.now() - t0;

  // -------------------------------------------------------------- 2. sort
  const t1 = performance.now();
  if (spec.sort && table.cols[spec.sort.col]) {
    const col = table.cols[spec.sort.col];
    const view = idx.subarray(0, matched);
    if (col.kind === 'num' || col.kind === 'date') {
      const d = col.data as Float64Array;
      sortFloatIndex(d, view, matched);
      // NaNs sort to the front under the bit encoding; move them to the tail.
      const hasNulls = col.nulls > 0;
      if (hasNulls) pinNaNsLast(d, view, matched);
      if (spec.sort.dir === -1) {
        if (hasNulls) reverseKeepNullsLast(view, matched, (r) => Number.isNaN(d[r]));
        else reverseInPlace(view, matched); // no nulls: plain reverse, no alloc
      }
    } else if (col.kind === 'cat') {
      const d = col.data as Uint32Array;
      // Sort by label, not by dict code: remap codes to their rank.
      const order = rankDict(col);
      const ranked = new Uint32Array(matched);
      for (let i = 0; i < matched; i++) {
        const c = d[view[i]];
        ranked[i] = c === NULL_CODE ? NULL_CODE : order[c];
      }
      const tmp = new Uint32Array(matched);
      for (let i = 0; i < matched; i++) tmp[i] = i;
      sortCodeIndex(ranked, tmp, matched, col.cardinality, NULL_CODE);
      const out = new Uint32Array(matched);
      for (let i = 0; i < matched; i++) out[i] = view[tmp[i]];
      view.set(out);
      if (spec.sort.dir === -1) reverseKeepNullsLast(view, matched, (r) => d[r] === NULL_CODE);
    } else {
      const d = col.data as Uint8Array;
      sortCodeIndex(d, view, matched, 2, 2);
      if (spec.sort.dir === -1) reverseKeepNullsLast(view, matched, (r) => d[r] === 2);
    }
  }
  const sortMs = performance.now() - t1;

  // --------------------------------------------------- 3. group + aggregate
  const t2 = performance.now();
  let groups: GroupResult | null = null;
  if (spec.group && table.cols[spec.group.col]) {
    groups = aggregate(table, spec, idx, matched);
  }
  const groupMs = performance.now() - t2;

  // ---------------------------------------------------------- 4. histogram
  let hist: HistResult | null = null;
  if (spec.histCol !== null && table.cols[spec.histCol]) {
    const col = table.cols[spec.histCol];
    if (col.kind === 'num' || col.kind === 'date') {
      const B = 64;
      const bins = new Float64Array(B);
      const d = col.data as Float64Array;
      const lo = col.min;
      const hi = col.max > col.min ? col.max : col.min + 1;
      const k = B / (hi - lo);
      for (let i = 0; i < matched; i++) {
        const v = d[idx[i]];
        if (Number.isNaN(v)) continue;
        let b = ((v - lo) * k) | 0;
        if (b < 0) b = 0;
        if (b >= B) b = B - 1;
        bins[b]++;
      }
      hist = { bins, lo, hi, col: spec.histCol };
    }
  }

  // Only the visible slice is ever read by the grid, but we hand back the whole
  // index so scrolling never round-trips to the worker.
  const index = idx.slice(0, matched);

  return {
    id,
    matched,
    index,
    groups,
    hist,
    stats: {
      filterMs, sortMs, groupMs,
      totalMs: performance.now() - tAll,
    },
  };
}

/** Allocation-free reverse for the common "no nulls" descending sort. */
function reverseInPlace(a: Uint32Array, n: number) {
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

function isNullVal(v: number, kind: string) {
  if (kind === 'cat') return v === NULL_CODE;
  if (kind === 'bool') return v === 2;
  return Number.isNaN(v);
}

function pinNaNsLast(d: Float64Array, view: Uint32Array, n: number) {
  let w = 0;
  const nan: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = view[i];
    if (Number.isNaN(d[r])) nan.push(r);
    else view[w++] = r;
  }
  for (let i = 0; i < nan.length; i++) view[w++] = nan[i];
}

const rankCache = new WeakMap<Column, Uint32Array>();
function rankDict(col: Column): Uint32Array {
  const hit = rankCache.get(col);
  if (hit) return hit;
  const dict = col.dict ?? [];
  const order = Array.from(dict, (_, i) => i);
  order.sort((a, b) => (dict[a] < dict[b] ? -1 : dict[a] > dict[b] ? 1 : 0));
  const rank = new Uint32Array(dict.length);
  for (let i = 0; i < order.length; i++) rank[order[i]] = i;
  rankCache.set(col, rank);
  return rank;
}

/**
 * Group-by with a dense key space.
 *
 * Categorical/boolean keys index directly by dict code. Numeric and date keys
 * are linearly binned into `bins` buckets. Either way the group id is an
 * integer, so accumulation is a flat typed-array write with no hashing.
 */
function aggregate(table: Table, spec: QuerySpec, idx: Uint32Array, matched: number): GroupResult {
  const gcol = table.cols[spec.group!.col];
  const bins = Math.max(1, Math.min(512, spec.group!.bins));

  let ngroups: number;
  let labelOf: (g: number) => string;
  let keyValOf: (g: number) => number;

  if (gcol.kind === 'cat') {
    const d = gcol.data as Uint32Array;
    ngroups = gcol.cardinality + 1; // last slot = null
    const nullG = gcol.cardinality;
    labelOf = (g) => (g === nullG ? '∅ null' : gcol.dict![g] ?? String(g));
    keyValOf = (g) => g;
  } else if (gcol.kind === 'bool') {
    ngroups = 3;
    labelOf = (g) => (g === 1 ? 'true' : g === 0 ? 'false' : '∅ null');
    keyValOf = (g) => g;
  } else {
    const d = gcol.data as Float64Array;
    const lo = gcol.min;
    const hi = gcol.max > gcol.min ? gcol.max : gcol.min + 1;
    const k = bins / (hi - lo);
    const w = (hi - lo) / bins;
    ngroups = bins + 1;
    const isDate = gcol.kind === 'date';
    labelOf = (g) => {
      if (g === bins) return '∅ null';
      const s = lo + g * w;
      if (isDate) return new Date(s).toISOString().slice(0, 10);
      return fmtBin(s, s + w, gcol.isInt);
    };
    keyValOf = (g) => (g === bins ? NaN : lo + g * w);
  }

  const count = new Float64Array(ngroups);
  const aggs = spec.aggs.filter((a) => table.cols[a.col]);
  const nAgg = aggs.length;

  // sum / min / max / count are single-pass; avg derives from sum/count.
  const sums = new Float64Array(ngroups * nAgg);
  const mins = new Float64Array(ngroups * nAgg).fill(Infinity);
  const maxs = new Float64Array(ngroups * nAgg).fill(-Infinity);
  const nonNull = new Float64Array(ngroups * nAgg);
  const needsMedian = aggs.some((a) => a.fn === 'median');

  const aggData: Float64Array[] = aggs.map((a) => table.cols[a.col].data as Float64Array);

  /**
   * Group ids are materialised once into a dense Uint32Array. This removes a
   * polymorphic closure call from the innermost accumulation loop and lets the
   * median pass reuse the same keys instead of recomputing them per aggregate.
   */
  const gids = new Uint32Array(matched);
  if (gcol.kind === 'cat') {
    const d = gcol.data as Uint32Array;
    const nullG = gcol.cardinality;
    for (let i = 0; i < matched; i++) {
      const c = d[idx[i]];
      gids[i] = c === NULL_CODE ? nullG : c;
    }
  } else if (gcol.kind === 'bool') {
    const d = gcol.data as Uint8Array;
    for (let i = 0; i < matched; i++) gids[i] = d[idx[i]];
  } else {
    const d = gcol.data as Float64Array;
    const lo = gcol.min;
    const hi = gcol.max > gcol.min ? gcol.max : gcol.min + 1;
    const k = bins / (hi - lo);
    for (let i = 0; i < matched; i++) {
      const v = d[idx[i]];
      if (Number.isNaN(v)) { gids[i] = bins; continue; }
      let b = ((v - lo) * k) | 0;
      if (b < 0) b = 0;
      else if (b >= bins) b = bins - 1;
      gids[i] = b;
    }
  }

  // Counting alone is a tight loop worth keeping separate from aggregation.
  for (let i = 0; i < matched; i++) count[gids[i]]++;

  if (nAgg === 1) {
    // Single-aggregate is by far the common case: specialise it so the inner
    // array-of-arrays indirection disappears.
    const d0 = aggData[0];
    for (let i = 0; i < matched; i++) {
      const v = d0[idx[i]];
      if (Number.isNaN(v)) continue;
      const o = gids[i];
      sums[o] += v;
      nonNull[o]++;
      if (v < mins[o]) mins[o] = v;
      if (v > maxs[o]) maxs[o] = v;
    }
  } else {
    for (let i = 0; i < matched; i++) {
      const r = idx[i];
      const g = gids[i];
      for (let k = 0; k < nAgg; k++) {
        const v = aggData[k][r];
        if (Number.isNaN(v)) continue;
        const o = g * nAgg + k;
        sums[o] += v;
        nonNull[o]++;
        if (v < mins[o]) mins[o] = v;
        if (v > maxs[o]) maxs[o] = v;
      }
    }
  }

  // Medians need the per-group values; only collect when actually requested.
  let medianVals: Float64Array[][] | null = null;
  if (needsMedian) {
    medianVals = [];
    for (let k = 0; k < nAgg; k++) {
      if (aggs[k].fn !== 'median') { medianVals.push([]); continue; }
      const buckets: Float64Array[] = new Array(ngroups);
      const fill = new Uint32Array(ngroups);
      for (let g = 0; g < ngroups; g++) buckets[g] = new Float64Array(count[g]);
      const dk = aggData[k];
      for (let i = 0; i < matched; i++) {
        const v = dk[idx[i]];
        if (!Number.isNaN(v)) {
          const g = gids[i];
          buckets[g][fill[g]++] = v;
        }
      }
      for (let g = 0; g < ngroups; g++) buckets[g] = buckets[g].subarray(0, fill[g]) as Float64Array;
      medianVals.push(buckets);
    }
  }

  // Drop empty groups, then rank by count and keep the top N.
  const live: number[] = [];
  for (let g = 0; g < ngroups; g++) if (count[g] > 0) live.push(g);
  live.sort((a, b) => count[b] - count[a]);
  const limit = Math.min(live.length, Math.max(1, spec.groupLimit));
  const truncated = live.length - limit;
  const keep = live.slice(0, limit);

  // Categorical groups read better in label order; numeric bins in key order.
  if (gcol.kind === 'cat' || gcol.kind === 'bool') {
    keep.sort((a, b) => {
      const la = labelOf(a);
      const lb = labelOf(b);
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
  } else {
    keep.sort((a, b) => a - b);
  }

  const labels: string[] = [];
  const keys = new Float64Array(keep.length);
  const outCount = new Float64Array(keep.length);
  const values: Float64Array[] = aggs.map(() => new Float64Array(keep.length));

  for (let i = 0; i < keep.length; i++) {
    const g = keep[i];
    labels.push(labelOf(g));
    keys[i] = keyValOf(g);
    outCount[i] = count[g];
    for (let k = 0; k < nAgg; k++) {
      const o = g * nAgg + k;
      const fn = aggs[k].fn;
      let v: number;
      if (fn === 'count') v = nonNull[o];
      else if (fn === 'sum') v = sums[o];
      else if (fn === 'avg') v = nonNull[o] ? sums[o] / nonNull[o] : NaN;
      else if (fn === 'min') v = nonNull[o] ? mins[o] : NaN;
      else if (fn === 'max') v = nonNull[o] ? maxs[o] : NaN;
      else {
        const arr = medianVals![k][g];
        v = arr && arr.length ? quickselect(Float64Array.from(arr), arr.length, arr.length >> 1) : NaN;
      }
      values[k][i] = v;
    }
  }

  return { labels, keys, count: outCount, values, truncated };
}

function fmtBin(a: number, b: number, isInt: boolean) {
  const f = (v: number) => {
    const av = Math.abs(v);
    if (av >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (av >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (av >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    if (isInt) return String(Math.round(v));
    if (av >= 10) return v.toFixed(0);
    if (av >= 1) return v.toFixed(1);
    return v.toFixed(2);
  };
  return `${f(a)} – ${f(b)}`;
}
