/// <reference lib="webworker" />
/**
 * Data worker. Owns the columnar store; the main thread never holds the data,
 * only the query results. Keeps the UI thread free for rendering at 60fps.
 */
import type { Column, Table, TableWire, WorkerReq, WorkerRes } from '../types';
import { parseCSV } from './csv';
import { runQuery } from './engine';
import { synthesize } from './synth';

let table: Table | null = null;

const post = (m: WorkerRes, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(m, transfer ?? []);

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

self.onmessage = (e: MessageEvent<WorkerReq>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'synth': {
        let last = -1;
        const wire = synthesize(msg.rows, msg.seed, (pct) => {
          const p = Math.round(pct * 100);
          if (p !== last && p % 4 === 0) {
            last = p;
            post({ id: msg.id, type: 'progress', phase: 'generating rows', pct });
          }
        });
        // Keep our own copy, then send a structured clone of the buffers.
        table = materialize(wire);
        const copies = wire.buffers.map((b) => b.slice(0));
        post({ id: msg.id, type: 'table', table: { ...wire, buffers: copies } }, copies);
        break;
      }
      case 'csv': {
        const wire = parseCSV(msg.buf, msg.name, (phase, pct) =>
          post({ id: msg.id, type: 'progress', phase, pct }),
        );
        table = materialize(wire);
        const copies = wire.buffers.map((b) => b.slice(0));
        post({ id: msg.id, type: 'table', table: { ...wire, buffers: copies } }, copies);
        break;
      }
      case 'query': {
        if (!table) return;
        const result = runQuery(table, msg.spec, msg.id);
        post({ id: msg.id, type: 'query', result }, [result.index.buffer]);
        break;
      }
      case 'export': {
        if (!table) return;
        const r = runQuery(table, msg.spec, msg.id);
        const csv = toCSV(table, r.index, Math.min(r.matched, msg.maxRows));
        post({ id: msg.id, type: 'export', csv, rows: Math.min(r.matched, msg.maxRows) });
        break;
      }
    }
  } catch (err) {
    post({ id: msg.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

function toCSV(t: Table, index: Uint32Array, n: number): string {
  const parts: string[] = [];
  parts.push(t.cols.map((c) => esc(c.name)).join(','));
  const line: string[] = new Array(t.cols.length);
  for (let i = 0; i < n; i++) {
    const r = index[i];
    for (let c = 0; c < t.cols.length; c++) {
      const col = t.cols[c];
      const v = col.data[r];
      if (col.kind === 'cat') line[c] = v === 0xffffffff ? '' : esc(col.dict![v] ?? '');
      else if (col.kind === 'bool') line[c] = v === 2 ? '' : v === 1 ? 'true' : 'false';
      else if (col.kind === 'date') line[c] = Number.isNaN(v) ? '' : new Date(v).toISOString();
      else line[c] = Number.isNaN(v) ? '' : String(v);
    }
    parts.push(line.join(','));
  }
  return parts.join('\n');
}

function esc(s: string) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
