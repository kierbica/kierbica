/**
 * Shared type contracts between the main thread and the data worker.
 *
 * Storage model: strictly columnar, backed by typed arrays.
 *   num  -> Float64Array  (NaN = null)
 *   date -> Float64Array  (epoch ms, NaN = null)
 *   bool -> Uint8Array    (0 | 1 | 2=null)
 *   cat  -> Uint32Array   (dictionary codes, 0xFFFFFFFF = null) + string[] dict
 */

export type ColKind = 'num' | 'cat' | 'date' | 'bool';

export const NULL_CODE = 0xffffffff;

export interface ColumnMeta {
  name: string;
  kind: ColKind;
  /** numeric/date domain (dict-code domain for cat) */
  min: number;
  max: number;
  nulls: number;
  cardinality: number;
  /** integer-valued numeric column (affects formatting) */
  isInt: boolean;
  /** dictionary for `cat` columns */
  dict?: string[];
  /** 40-bin distribution sparkline, normalised 0..1 */
  spark?: number[];
}

/** Wire format for a freshly loaded table. Buffers are transferred, not copied. */
export interface TableWire {
  name: string;
  nrows: number;
  cols: ColumnMeta[];
  buffers: ArrayBuffer[];
  bytes: number;
  ms: number;
}

/** Main-thread materialised column. */
export interface Column extends ColumnMeta {
  data: Float64Array | Uint32Array | Uint8Array;
}

export interface Table {
  name: string;
  nrows: number;
  cols: Column[];
  bytes: number;
}

// ---------------------------------------------------------------- query spec

export type FilterOp = 'range' | 'in' | 'contains' | 'isnull' | 'notnull';

export interface Filter {
  id: string;
  col: number;
  op: FilterOp;
  lo?: number;
  hi?: number;
  /** dictionary codes for `in` */
  set?: number[];
  text?: string;
  enabled: boolean;
}

export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'median';

export interface QuerySpec {
  filters: Filter[];
  sort: { col: number; dir: 1 | -1 } | null;
  /** group-by key column; numeric/date keys are binned */
  group: { col: number; bins: number } | null;
  aggs: { col: number; fn: AggFn }[];
  /** column to build a 64-bin histogram for (drives the distribution panel) */
  histCol: number | null;
  /** limit on returned group rows */
  groupLimit: number;
}

export interface GroupResult {
  labels: string[];
  /** raw key (dict code or bin lower edge) per group */
  keys: Float64Array;
  count: Float64Array;
  /** one Float64Array per requested agg, parallel to spec.aggs */
  values: Float64Array[];
  truncated: number;
}

export interface HistResult {
  bins: Float64Array;
  lo: number;
  hi: number;
  col: number;
}

export interface QueryResult {
  id: number;
  matched: number;
  /** ordered row ids to display */
  index: Uint32Array;
  groups: GroupResult | null;
  hist: HistResult | null;
  stats: { filterMs: number; sortMs: number; groupMs: number; totalMs: number };
}

// ------------------------------------------------------------------ messages

export type WorkerReq =
  | { id: number; type: 'synth'; rows: number; seed: number }
  | { id: number; type: 'csv'; buf: ArrayBuffer; name: string }
  | { id: number; type: 'query'; spec: QuerySpec }
  | { id: number; type: 'export'; spec: QuerySpec; maxRows: number };

export type WorkerRes =
  | { id: number; type: 'table'; table: TableWire }
  | { id: number; type: 'query'; result: QueryResult }
  | { id: number; type: 'export'; csv: string; rows: number }
  | { id: number; type: 'progress'; phase: string; pct: number }
  | { id: number; type: 'error'; message: string };
