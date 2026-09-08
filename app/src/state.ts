/**
 * Application state + worker bridge.
 *
 * Queries are versioned and coalesced: while a query is in flight, new requests
 * replace a single pending slot rather than queueing, so dragging a slider
 * never backs up the worker. Results arriving out of order are dropped.
 */
import type {
  AggFn, Column, Filter, QueryResult, QuerySpec, Table, TableWire, WorkerReq, WorkerRes,
} from './types';

export type View = 'grid' | 'bars' | 'trend' | 'scatter' | 'matrix';

export interface AppState {
  table: Table | null;
  result: QueryResult | null;
  filters: Filter[];
  sort: { col: number; dir: 1 | -1 } | null;
  view: View;
  groupCol: number;
  groupBins: number;
  metricCol: number;
  metricFn: AggFn;
  trendCol: number;
  scatterX: number;
  scatterY: number;
  scatterC: number;
  matrixA: number;
  matrixB: number;
  histCol: number | null;
  focusCol: number;
  busy: boolean;
  loadMs: number;
  leftOpen: boolean;
  rightOpen: boolean;
}

type Listener = (s: AppState, reason: string) => void;

let uid = 0;
export const nextId = () => ++uid;

export class Store {
  state: AppState = {
    table: null, result: null, filters: [], sort: null, view: 'grid',
    groupCol: -1, groupBins: 24, metricCol: -1, metricFn: 'sum', trendCol: -1,
    scatterX: -1, scatterY: -1, scatterC: -1, matrixA: -1, matrixB: -1,
    histCol: null, focusCol: -1, busy: false, loadMs: 0,
    leftOpen: true, rightOpen: true,
  };

  private worker: Worker;
  private listeners: Listener[] = [];
  private qid = 0;
  private inflight = false;
  private pending = false;
  private tableCbs: ((t: Table) => void)[] = [];
  private progressCb: ((phase: string, pct: number) => void) | null = null;
  private errorCb: ((m: string) => void) | null = null;
  private exportCb: ((csv: string, rows: number) => void) | null = null;
  /** rolling worker round-trip, ms */
  lastQueryMs = 0;
  lastRoundTrip = 0;

  constructor() {
    this.worker = new Worker(new URL('./worker/main.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerRes>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.errorCb?.(e.message || 'worker error');
  }

  on(fn: Listener) { this.listeners.push(fn); }
  onTable(fn: (t: Table) => void) { this.tableCbs.push(fn); }
  onProgress(fn: (phase: string, pct: number) => void) { this.progressCb = fn; }
  onError(fn: (m: string) => void) { this.errorCb = fn; }
  onExport(fn: (csv: string, rows: number) => void) { this.exportCb = fn; }

  emit(reason: string) {
    for (const l of this.listeners) l(this.state, reason);
  }

  private sentAt = 0;

  private onMessage(m: WorkerRes) {
    switch (m.type) {
      case 'progress':
        this.progressCb?.(m.phase, m.pct);
        break;
      case 'table': {
        this.state.table = materialize(m.table);
        this.state.loadMs = m.table.ms;
        this.state.result = null;
        this.state.filters = [];
        this.state.sort = null;
        autoPick(this.state);
        for (const cb of this.tableCbs) cb(this.state.table);
        this.emit('table');
        this.query();
        break;
      }
      case 'query': {
        this.inflight = false;
        this.lastRoundTrip = performance.now() - this.sentAt;
        if (m.result.id >= this.qid) {
          this.state.result = m.result;
          this.lastQueryMs = m.result.stats.totalMs;
        }
        this.state.busy = false;
        this.emit('result');
        if (this.pending) { this.pending = false; this.query(); }
        break;
      }
      case 'export':
        this.exportCb?.(m.csv, m.rows);
        break;
      case 'error':
        this.state.busy = false;
        this.inflight = false;
        this.errorCb?.(m.message);
        this.emit('error');
        break;
    }
  }

  private send(msg: WorkerReq, transfer?: Transferable[]) {
    this.worker.postMessage(msg, transfer ?? []);
  }

  synth(rows: number, seed = 7) {
    this.state.busy = true;
    this.emit('busy');
    this.send({ id: nextId(), type: 'synth', rows, seed });
  }

  loadCSV(buf: ArrayBuffer, name: string) {
    this.state.busy = true;
    this.emit('busy');
    this.send({ id: nextId(), type: 'csv', buf, name }, [buf]);
  }

  spec(): QuerySpec {
    const s = this.state;
    const aggs: { col: number; fn: AggFn }[] = [];
    if (s.metricCol >= 0) aggs.push({ col: s.metricCol, fn: s.metricFn });
    return {
      filters: s.filters,
      sort: s.sort,
      group: s.groupCol >= 0 ? { col: s.groupCol, bins: s.groupBins } : null,
      aggs,
      histCol: s.histCol,
      groupLimit: s.view === 'bars' ? 40 : 200,
    };
  }

  /** Coalesced query dispatch. */
  query() {
    if (!this.state.table) return;
    if (this.inflight) { this.pending = true; return; }
    this.inflight = true;
    this.state.busy = true;
    this.sentAt = performance.now();
    this.send({ id: ++this.qid, type: 'query', spec: this.spec() });
    this.emit('busy');
  }

  exportCSV(maxRows = 200000) {
    this.send({ id: nextId(), type: 'export', spec: this.spec(), maxRows });
  }

  // ------------------------------------------------------------ mutations
  setFilter(f: Filter) {
    const i = this.state.filters.findIndex((x) => x.id === f.id);
    if (i >= 0) this.state.filters[i] = f;
    else this.state.filters.push(f);
    this.emit('filters');
    this.query();
  }

  removeFilter(id: string) {
    this.state.filters = this.state.filters.filter((f) => f.id !== id);
    this.emit('filters');
    this.query();
  }

  clearFilters() {
    if (!this.state.filters.length) return;
    this.state.filters = [];
    this.emit('filters');
    this.query();
  }

  toggleFilter(id: string) {
    const f = this.state.filters.find((x) => x.id === id);
    if (!f) return;
    f.enabled = !f.enabled;
    this.emit('filters');
    this.query();
  }

  setSort(col: number) {
    const s = this.state;
    if (s.sort && s.sort.col === col) {
      if (s.sort.dir === -1) s.sort = { col, dir: 1 };
      else s.sort = null;
    } else {
      s.sort = { col, dir: -1 };
    }
    this.emit('sort');
    this.query();
  }

  patch(p: Partial<AppState>, requery = true) {
    Object.assign(this.state, p);
    this.emit('patch');
    if (requery) this.query();
  }
}

function materialize(w: TableWire): Table {
  const cols: Column[] = w.cols.map((c, i) => {
    const buf = w.buffers[i];
    const data =
      c.kind === 'cat' ? new Uint32Array(buf)
      : c.kind === 'bool' ? new Uint8Array(buf)
      : new Float64Array(buf);
    return { ...c, data };
  });
  return { name: w.name, nrows: w.nrows, cols, bytes: w.bytes };
}

/** Choose sensible default columns for each view when a table is loaded. */
function autoPick(s: AppState) {
  const t = s.table!;
  const nums = t.cols.map((c, i) => ({ c, i })).filter((x) => x.c.kind === 'num');
  const cats = t.cols.map((c, i) => ({ c, i }))
    .filter((x) => x.c.kind === 'cat' && x.c.cardinality > 1 && x.c.cardinality <= 60);
  const dates = t.cols.map((c, i) => ({ c, i })).filter((x) => x.c.kind === 'date');

  // Identifier-like columns plot as meaningless smears, so they never get
  // picked as a default axis or metric.
  const analytic = nums.filter((x) => !isIdLike(x.c, t.nrows));
  const byInterest = (analytic.length ? analytic : nums)
    .slice()
    .sort((a, b) => spread(b.c) - spread(a.c));

  s.groupCol = cats[0]?.i ?? dates[0]?.i ?? nums[0]?.i ?? -1;
  s.metricCol = byInterest[0]?.i ?? -1;
  s.metricFn = 'sum';
  s.trendCol = dates[0]?.i ?? byInterest[0]?.i ?? -1;

  // Scatter reads best with two *different* well-spread measures.
  s.scatterX = byInterest[0]?.i ?? -1;
  s.scatterY = byInterest.find((x) => x.i !== s.scatterX)?.i ?? s.scatterX;
  s.scatterC = cats[0]?.i ?? -1;

  // Matrix needs two dimensions that actually cross. `country` nested inside
  // `region` yields a block-diagonal chart that tells you nothing, so prefer a
  // pair with no functional dependency.
  s.matrixA = cats[0]?.i ?? -1;
  s.matrixB = pickIndependent(t, cats, s.matrixA);

  s.histCol = byInterest[0]?.i ?? null;
  s.focusCol = byInterest[0]?.i ?? 0;
}

function spread(c: Column) {
  return c.max - c.min > 0 ? Math.log10(Math.abs(c.max - c.min) + 1) : 0;
}

/** Heuristic: surrogate keys / row ids. */
function isIdLike(c: Column, nrows: number): boolean {
  if (/(^|[_\s-])(id|uuid|guid|key|code|index|no|num)$/i.test(c.name)) return true;
  if (c.isInt && c.max - c.min > 0) {
    // near-unique integers spanning roughly one value per row
    const density = (c.max - c.min + 1) / Math.max(1, nrows);
    if (density > 0.35 && density < 3) return true;
  }
  return false;
}

/**
 * Pick a second categorical dimension that is not determined by the first.
 * Sampled check: if every B value maps to exactly one A value, B is nested.
 */
function pickIndependent(
  t: Table, cats: { c: Column; i: number }[], a: number,
): number {
  const others = cats.filter((x) => x.i !== a);
  if (!others.length) return a;
  const da = t.cols[a]?.data;
  if (!da) return others[0].i;
  const stride = Math.max(1, Math.floor(t.nrows / 4000));

  let best = others[0].i;
  let bestScore = -1;
  for (const { c, i } of others) {
    const db = c.data;
    const seen = new Map<number, number>();
    let violations = 0;
    let n = 0;
    for (let r = 0; r < t.nrows; r += stride) {
      const bv = db[r];
      const av = da[r];
      n++;
      const prev = seen.get(bv);
      if (prev === undefined) seen.set(bv, av);
      else if (prev !== av) violations++;
    }
    // crossing dimensions produce many violations; nested ones produce zero
    const score = violations / Math.max(1, n);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}
