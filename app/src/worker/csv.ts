/**
 * Single-pass CSV -> columnar typed arrays.
 *
 * Parses straight out of the ArrayBuffer at the byte level (no intermediate
 * string array, no split('\n')), inferring each column as num / date / bool /
 * cat while it goes. Handles RFC-4180 quoting, CRLF, and embedded newlines.
 */
import type { ColumnMeta, TableWire } from '../types';
import { NULL_CODE } from '../types';
import { spark } from './synth';

const enum T { EMPTY = 0, NUM = 1, BOOL = 2, DATE = 3, STR = 4 }

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function classify(s: string): T {
  if (s.length === 0) return T.EMPTY;
  const l = s.toLowerCase();
  if (l === 'null' || l === 'na' || l === 'n/a' || l === 'nan' || l === '-') return T.EMPTY;
  if (l === 'true' || l === 'false' || l === 'yes' || l === 'no') return T.BOOL;
  if (s.length < 32) {
    // fast numeric probe before the regex
    const c = s.charCodeAt(0);
    if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
      if (DATE_RE.test(s)) return T.DATE;
      const n = Number(s.indexOf(',') >= 0 ? s.replace(/,/g, '') : s);
      if (!Number.isNaN(n)) return T.NUM;
    }
  }
  if (DATE_RE.test(s)) return T.DATE;
  return T.STR;
}

export function parseCSV(
  buf: ArrayBuffer,
  name: string,
  onProgress: (phase: string, pct: number) => void,
): TableWire {
  const t0 = performance.now();
  const bytes = new Uint8Array(buf);
  const len = bytes.length;
  const dec = new TextDecoder('utf-8');

  // ---- pass 1: field boundaries -----------------------------------------
  // Emits rows as arrays of strings, but reuses one decoder + slices lazily.
  let p = 0;
  // strip UTF-8 BOM
  if (len >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) p = 3;

  const fields: string[] = [];
  const rowStarts: number[] = [];
  let quoted = false;
  let fieldStart = p;
  let hasQuote = false;

  const pushField = (end: number) => {
    let s: string;
    if (hasQuote) {
      s = dec.decode(bytes.subarray(fieldStart, end));
      s = s.replace(/^"|"$/g, '').replace(/""/g, '"');
      hasQuote = false;
    } else {
      s = dec.decode(bytes.subarray(fieldStart, end));
    }
    fields.push(s.trim());
  };

  rowStarts.push(0);
  const progStep = Math.max(1, (len / 50) | 0);
  let nextProg = progStep;

  for (let i = p; i < len; i++) {
    const c = bytes[i];
    if (i >= nextProg) {
      onProgress('parsing', (i / len) * 0.55);
      nextProg += progStep;
    }
    if (quoted) {
      if (c === 34) {
        if (i + 1 < len && bytes[i + 1] === 34) i++;
        else quoted = false;
      }
      continue;
    }
    if (c === 34) { quoted = true; hasQuote = true; continue; }
    if (c === 44) { pushField(i); fieldStart = i + 1; continue; }
    if (c === 10 || c === 13) {
      pushField(i);
      fieldStart = i + 1;
      if (c === 13 && i + 1 < len && bytes[i + 1] === 10) { i++; fieldStart = i + 1; }
      rowStarts.push(fields.length);
      continue;
    }
  }
  if (fieldStart < len) { pushField(len); rowStarts.push(fields.length); }
  else if (fields.length > (rowStarts[rowStarts.length - 1] ?? 0)) rowStarts.push(fields.length);

  if (rowStarts.length < 2) throw new Error('CSV appears to be empty');

  const ncols = rowStarts[1] - rowStarts[0];
  if (ncols === 0) throw new Error('CSV has no columns');
  const header = fields.slice(0, ncols).map((h, i) => h || `col_${i + 1}`);

  // Rows are only valid if they have the right arity; ragged rows get padded.
  const dataRows = rowStarts.length - 2;
  const nrows = Math.max(0, dataRows);
  if (nrows === 0) throw new Error('CSV has a header but no data rows');

  // ---- pass 2: infer types ----------------------------------------------
  onProgress('inferring types', 0.6);
  const kinds: T[] = new Array(ncols).fill(T.EMPTY);
  const sampleN = Math.min(nrows, 4000);
  const sampleStride = Math.max(1, (nrows / sampleN) | 0);
  for (let rIdx = 0; rIdx < nrows; rIdx += sampleStride) {
    const base = rowStarts[rIdx + 1];
    const arity = rowStarts[rIdx + 2] - base;
    for (let c = 0; c < ncols && c < arity; c++) {
      const t = classify(fields[base + c]);
      if (t === T.EMPTY) continue;
      const cur = kinds[c];
      if (cur === T.EMPTY) kinds[c] = t;
      else if (cur !== t) {
        // NUM + DATE -> STR ; anything mixed with STR -> STR
        kinds[c] = (cur === T.NUM && t === T.BOOL) || (cur === T.BOOL && t === T.NUM) ? T.NUM : T.STR;
      }
    }
  }

  // A high-cardinality string column stays categorical (dictionary) regardless;
  // the grid renders it fine and filters stay fast.
  const cols: ColumnMeta[] = [];
  const buffers: ArrayBuffer[] = [];
  const store: (Float64Array | Uint32Array | Uint8Array)[] = [];
  const dicts: (Map<string, number> | null)[] = [];
  const dictArr: (string[] | null)[] = [];

  for (let c = 0; c < ncols; c++) {
    const k = kinds[c];
    if (k === T.NUM || k === T.DATE) { store.push(new Float64Array(nrows)); dicts.push(null); dictArr.push(null); }
    else if (k === T.BOOL) { store.push(new Uint8Array(nrows)); dicts.push(null); dictArr.push(null); }
    else { store.push(new Uint32Array(nrows)); dicts.push(new Map()); dictArr.push([]); }
  }

  // ---- pass 3: fill ------------------------------------------------------
  const fillStep = Math.max(1, (nrows / 40) | 0);
  for (let rIdx = 0; rIdx < nrows; rIdx++) {
    if (rIdx % fillStep === 0) onProgress('building columns', 0.6 + (rIdx / nrows) * 0.4);
    const base = rowStarts[rIdx + 1];
    const arity = rowStarts[rIdx + 2] - base;
    for (let c = 0; c < ncols; c++) {
      const raw = c < arity ? fields[base + c] : '';
      const k = kinds[c];
      if (k === T.NUM) {
        const t = classify(raw);
        (store[c] as Float64Array)[rIdx] =
          t === T.EMPTY ? NaN : Number(raw.indexOf(',') >= 0 ? raw.replace(/,/g, '') : raw);
      } else if (k === T.DATE) {
        const v = raw ? Date.parse(raw) : NaN;
        (store[c] as Float64Array)[rIdx] = Number.isNaN(v) ? NaN : v;
      } else if (k === T.BOOL) {
        const l = raw.toLowerCase();
        (store[c] as Uint8Array)[rIdx] = l === 'true' || l === 'yes' || l === '1' ? 1 : l === '' ? 2 : 0;
      } else {
        if (raw === '') { (store[c] as Uint32Array)[rIdx] = NULL_CODE; continue; }
        const m = dicts[c]!;
        let code = m.get(raw);
        if (code === undefined) { code = dictArr[c]!.length; m.set(raw, code); dictArr[c]!.push(raw); }
        (store[c] as Uint32Array)[rIdx] = code;
      }
    }
  }

  for (let c = 0; c < ncols; c++) {
    const k = kinds[c];
    const name0 = header[c];
    if (k === T.NUM || k === T.DATE) {
      const d = store[c] as Float64Array;
      let min = Infinity, max = -Infinity, nulls = 0, isInt = true;
      for (let i = 0; i < nrows; i++) {
        const v = d[i];
        if (Number.isNaN(v)) { nulls++; continue; }
        if (v < min) min = v;
        if (v > max) max = v;
        if (isInt && !Number.isInteger(v)) isInt = false;
      }
      if (min === Infinity) { min = 0; max = 0; }
      cols.push({
        name: name0, kind: k === T.DATE ? 'date' : 'num',
        min, max, nulls, cardinality: 0, isInt: k === T.DATE ? false : isInt,
        spark: spark(d, nrows, min, max),
      });
      buffers.push(d.buffer as ArrayBuffer);
    } else if (k === T.BOOL) {
      const d = store[c] as Uint8Array;
      let t = 0, nulls = 0;
      for (let i = 0; i < nrows; i++) { if (d[i] === 1) t++; else if (d[i] === 2) nulls++; }
      cols.push({
        name: name0, kind: 'bool', min: 0, max: 1, nulls, cardinality: 2, isInt: true,
        spark: [(nrows - t - nulls) / nrows, t / nrows],
      });
      buffers.push(d.buffer as ArrayBuffer);
    } else {
      const d = store[c] as Uint32Array;
      const dict = dictArr[c]!;
      const counts = new Float64Array(Math.max(1, dict.length));
      let nulls = 0;
      for (let i = 0; i < nrows; i++) { if (d[i] === NULL_CODE) nulls++; else counts[d[i]]++; }
      let mx = 0;
      for (let i = 0; i < counts.length; i++) if (counts[i] > mx) mx = counts[i];
      cols.push({
        name: name0, kind: 'cat', min: 0, max: Math.max(0, dict.length - 1),
        nulls, cardinality: dict.length, isInt: true, dict,
        spark: Array.from(counts.subarray(0, Math.min(40, counts.length)), (v) => (mx ? v / mx : 0)),
      });
      buffers.push(d.buffer as ArrayBuffer);
    }
  }

  let byteTotal = 0;
  for (const b of buffers) byteTotal += b.byteLength;
  onProgress('done', 1);

  return {
    name: name.replace(/\.csv$/i, ''),
    nrows,
    cols,
    buffers,
    bytes: byteTotal,
    ms: performance.now() - t0,
  };
}
