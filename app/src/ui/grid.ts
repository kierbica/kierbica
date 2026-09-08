/**
 * Canvas data grid.
 *
 * The DOM contains exactly two elements: a canvas and an empty scroll spacer.
 * Rows are painted directly to the canvas from the result index, so the row
 * count has no effect on DOM size or memory — 10 rows and 10 million rows cost
 * the same. Painting is clipped to the visible window and skipped entirely when
 * neither scroll offset nor data version has changed.
 */
import type { Column, Table } from '../types';
import { NULL_CODE } from '../types';
import { color, compact, date as fmtDate } from '../fmt';

export interface GridHost {
  table: Table | null;
  index: Uint32Array;
  matched: number;
  sortCol: number;
  sortDir: 1 | -1;
  onSort(col: number): void;
  onHeaderMenu(col: number, x: number, y: number): void;
}

const ROW_H = 23;
const HEAD_H = 29;
const MIN_W = 62;
const PAD = 9;

export class DataGrid {
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sc: HTMLElement;
  private inner: HTMLElement;
  private pop: HTMLElement;

  private widths: number[] = [];
  private dpr = 1;
  private w = 0;
  private h = 0;
  private scrollTop = 0;
  private scrollLeft = 0;
  private hoverRow = -1;
  private hoverCol = -1;
  private dirty = true;
  private resizing = -1;
  private resizeX = 0;
  private resizeW = 0;
  private selRow = -1;

  /** rows actually painted on the last frame — surfaced in the status bar */
  lastPainted = 0;

  constructor(private root: HTMLElement, private host: GridHost) {
    root.innerHTML = `
      <canvas id="gridCanvas"></canvas>
      <div class="gscroll" tabindex="0"><div class="gscroll-inner"></div></div>
      <div class="cellpop hidden"></div>`;
    this.cv = root.querySelector('canvas')!;
    this.ctx = this.cv.getContext('2d', { alpha: false })!;
    this.sc = root.querySelector('.gscroll')!;
    this.inner = root.querySelector('.gscroll-inner')!;
    this.pop = root.querySelector('.cellpop')!;

    this.sc.addEventListener('scroll', this.onScroll, { passive: true });
    this.sc.addEventListener('mousemove', this.onMove);
    this.sc.addEventListener('mouseleave', this.onLeave);
    this.sc.addEventListener('mousedown', this.onDown);
    this.sc.addEventListener('dblclick', this.onDbl);
    this.sc.addEventListener('keydown', this.onKey);
    window.addEventListener('mousemove', this.onDrag);
    window.addEventListener('mouseup', this.onUp);
  }

  /** Recompute column widths from a sample of the data. */
  layout(table: Table | null) {
    if (!table) { this.widths = []; return; }
    const c = this.ctx;
    c.font = '12px ui-monospace, monospace';
    this.widths = table.cols.map((col) => {
      let w = c.measureText(col.name).width + 34;
      const sample = Math.min(this.host.matched || table.nrows, 90);
      for (let i = 0; i < sample; i++) {
        const r = this.host.matched ? this.host.index[(i * 7) % this.host.matched] : i;
        const s = cellText(col, r);
        const t = c.measureText(s).width + PAD * 2 + 6;
        if (t > w) w = t;
      }
      return Math.max(MIN_W, Math.min(230, Math.ceil(w)));
    });
    this.dirty = true;
  }

  resize() {
    const r = this.root.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = r.width;
    this.h = r.height;
    this.cv.width = Math.max(1, Math.round(r.width * this.dpr));
    this.cv.height = Math.max(1, Math.round(r.height * this.dpr));
    this.dirty = true;
  }

  invalidate() { this.dirty = true; }

  /** Called every animation frame; cheap no-op when nothing changed. */
  tick() {
    if (!this.dirty) return false;
    this.dirty = false;
    this.paint();
    return true;
  }

  private onScroll = () => {
    this.scrollTop = this.sc.scrollTop;
    this.scrollLeft = this.sc.scrollLeft;
    this.dirty = true;
    this.pop.classList.add('hidden');
  };

  private totalW() {
    let s = 0;
    for (const w of this.widths) s += w;
    return s;
  }

  private colAt(x: number): number {
    let acc = 0;
    for (let i = 0; i < this.widths.length; i++) {
      acc += this.widths[i];
      if (x < acc) return i;
    }
    return -1;
  }

  private edgeAt(x: number): number {
    let acc = 0;
    for (let i = 0; i < this.widths.length; i++) {
      acc += this.widths[i];
      if (Math.abs(x - acc) < 4) return i;
    }
    return -1;
  }

  private onMove = (e: MouseEvent) => {
    const r = this.sc.getBoundingClientRect();
    const x = e.clientX - r.left + this.scrollLeft;
    const y = e.clientY - r.top;
    this.sc.style.cursor = this.edgeAt(x) >= 0 ? 'col-resize' : y < HEAD_H ? 'pointer' : 'default';

    const row = y < HEAD_H ? -1 : Math.floor((y - HEAD_H + this.scrollTop) / ROW_H);
    const col = this.colAt(x);
    if (row !== this.hoverRow || col !== this.hoverCol) {
      this.hoverRow = row;
      this.hoverCol = col;
      this.dirty = true;
      this.showPop(e, row, col);
    }
  };

  private showPop(e: MouseEvent, row: number, col: number) {
    const t = this.host.table;
    if (!t || row < 0 || row >= this.host.matched || col < 0) {
      this.pop.classList.add('hidden');
      return;
    }
    const c = t.cols[col];
    const txt = cellText(c, this.host.index[row]);
    // Only pop when the text is actually clipped.
    this.ctx.font = '12px ui-monospace, monospace';
    if (this.ctx.measureText(txt).width + PAD * 2 < this.widths[col]) {
      this.pop.classList.add('hidden');
      return;
    }
    const r = this.root.getBoundingClientRect();
    this.pop.textContent = txt;
    this.pop.classList.remove('hidden');
    this.pop.style.left = Math.min(e.clientX - r.left + 12, this.w - 340) + 'px';
    this.pop.style.top = e.clientY - r.top + 14 + 'px';
  }

  private onLeave = () => {
    this.hoverRow = -1;
    this.hoverCol = -1;
    this.pop.classList.add('hidden');
    this.dirty = true;
  };

  private onDown = (e: MouseEvent) => {
    const r = this.sc.getBoundingClientRect();
    const x = e.clientX - r.left + this.scrollLeft;
    const y = e.clientY - r.top;
    const edge = this.edgeAt(x);
    if (edge >= 0) {
      this.resizing = edge;
      this.resizeX = e.clientX;
      this.resizeW = this.widths[edge];
      e.preventDefault();
      return;
    }
    if (y < HEAD_H) {
      const col = this.colAt(x);
      if (col >= 0) {
        if (e.altKey || e.button === 2) this.host.onHeaderMenu(col, e.clientX, e.clientY);
        else this.host.onSort(col);
      }
      return;
    }
    const row = Math.floor((y - HEAD_H + this.scrollTop) / ROW_H);
    this.selRow = row >= 0 && row < this.host.matched ? row : -1;
    this.dirty = true;
    this.sc.focus();
  };

  private onDbl = (e: MouseEvent) => {
    const r = this.sc.getBoundingClientRect();
    const x = e.clientX - r.left + this.scrollLeft;
    const edge = this.edgeAt(x);
    if (edge >= 0) { this.autoFit(edge); e.preventDefault(); }
  };

  private autoFit(col: number) {
    const t = this.host.table;
    if (!t) return;
    const c = this.ctx;
    c.font = '12px ui-monospace, monospace';
    let w = c.measureText(t.cols[col].name).width + 34;
    const n = Math.min(this.host.matched, 400);
    for (let i = 0; i < n; i++) {
      const s = cellText(t.cols[col], this.host.index[i]);
      const m = c.measureText(s).width + PAD * 2 + 6;
      if (m > w) w = m;
    }
    this.widths[col] = Math.max(MIN_W, Math.min(400, Math.ceil(w)));
    this.dirty = true;
    this.syncSpacer();
  }

  private onDrag = (e: MouseEvent) => {
    if (this.resizing < 0) return;
    this.widths[this.resizing] = Math.max(MIN_W, this.resizeW + (e.clientX - this.resizeX));
    this.dirty = true;
    this.syncSpacer();
  };

  private onUp = () => { this.resizing = -1; };

  private onKey = (e: KeyboardEvent) => {
    const page = Math.floor((this.h - HEAD_H) / ROW_H);
    let d = 0;
    if (e.key === 'ArrowDown') d = 1;
    else if (e.key === 'ArrowUp') d = -1;
    else if (e.key === 'PageDown') d = page;
    else if (e.key === 'PageUp') d = -page;
    else if (e.key === 'Home') { this.sc.scrollTop = 0; return; }
    else if (e.key === 'End') { this.sc.scrollTop = this.inner.offsetHeight; return; }
    else return;
    e.preventDefault();
    this.selRow = Math.max(0, Math.min(this.host.matched - 1, this.selRow + d));
    const top = this.selRow * ROW_H;
    if (top < this.scrollTop) this.sc.scrollTop = top;
    else if (top + ROW_H > this.scrollTop + this.h - HEAD_H) {
      this.sc.scrollTop = top + ROW_H - (this.h - HEAD_H);
    }
    this.dirty = true;
  };

  syncSpacer() {
    this.inner.style.height = Math.max(1, this.host.matched * ROW_H + HEAD_H) + 'px';
    this.inner.style.width = Math.max(1, this.totalW()) + 'px';
  }

  private paint() {
    const c = this.ctx;
    const t = this.host.table;
    c.save();
    c.scale(this.dpr, this.dpr);
    c.fillStyle = '#07090e';
    c.fillRect(0, 0, this.w, this.h);

    if (!t || this.host.matched === 0) {
      c.fillStyle = '#5d6a80';
      c.font = '13px Inter, system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText(t ? 'No rows match the current filters' : 'No data loaded', this.w / 2, this.h / 2);
      c.textAlign = 'left';
      c.restore();
      this.lastPainted = 0;
      return;
    }

    const sl = this.scrollLeft;
    const st = this.scrollTop;
    const first = Math.max(0, Math.floor(st / ROW_H));
    const last = Math.min(this.host.matched - 1, Math.ceil((st + this.h) / ROW_H));

    // Horizontal culling: find the first and last visible columns up front so
    // off-screen columns cost nothing.
    const xs: number[] = [];
    let acc = 0;
    for (let i = 0; i < this.widths.length; i++) { xs.push(acc); acc += this.widths[i]; }
    let c0 = 0;
    while (c0 < xs.length - 1 && xs[c0] + this.widths[c0] < sl) c0++;
    let c1 = c0;
    while (c1 < xs.length && xs[c1] < sl + this.w) c1++;
    c1 = Math.min(c1, xs.length - 1);

    c.font = '12px ui-monospace, SF Mono, Menlo, monospace';
    c.textBaseline = 'middle';

    let painted = 0;
    // ---- rows
    for (let ri = first; ri <= last; ri++) {
      const y = HEAD_H + ri * ROW_H - st;
      if (y + ROW_H < HEAD_H || y > this.h) continue;
      const row = this.host.index[ri];
      const isHover = ri === this.hoverRow;
      const isSel = ri === this.selRow;

      if (isSel) c.fillStyle = 'rgba(77,208,255,.13)';
      else if (isHover) c.fillStyle = '#101420';
      else if (ri & 1) c.fillStyle = '#0a0d14';
      else c.fillStyle = '#07090e';
      c.fillRect(0, y, this.w, ROW_H);

      if (isSel) {
        c.fillStyle = '#4dd0ff';
        c.fillRect(0, y, 2, ROW_H);
      }

      for (let ci = c0; ci <= c1; ci++) {
        const col = t.cols[ci];
        const x = xs[ci] - sl;
        const w = this.widths[ci];
        if (x + w < 0 || x > this.w) continue;

        const v = col.data[row];
        const isNull =
          col.kind === 'cat' ? v === NULL_CODE : col.kind === 'bool' ? v === 2 : Number.isNaN(v);

        if (isNull) {
          c.fillStyle = '#39435a';
          c.fillText('—', x + PAD, y + ROW_H / 2);
          painted++;
          continue;
        }

        if (col.kind === 'num' || col.kind === 'date') {
          // In-cell magnitude bar for numeric columns: instant visual scan.
          if (col.kind === 'num' && col.max > col.min) {
            const f = (v - col.min) / (col.max - col.min);
            c.fillStyle = 'rgba(77,208,255,.10)';
            c.fillRect(x + 1, y + ROW_H - 3, Math.max(1, (w - 2) * f), 2);
          }
          c.fillStyle = '#d7dfee';
          const s = col.kind === 'date' ? fmtDate(v) : compact(v, col.isInt);
          c.textAlign = 'right';
          clipText(c, s, x + w - PAD, y + ROW_H / 2, w - PAD * 2);
          c.textAlign = 'left';
        } else if (col.kind === 'bool') {
          c.fillStyle = v === 1 ? '#37e2a0' : '#6d7a90';
          c.fillText(v === 1 ? 'true' : 'false', x + PAD, y + ROW_H / 2);
        } else {
          // Categorical: tint by dict code so groups are visible at a glance.
          const s = col.dict![v] ?? '';
          if (col.cardinality <= 24) {
            const cc = color(v);
            c.fillStyle = cc + '1e';
            const tw = Math.min(c.measureText(s).width + 12, w - PAD * 2 + 4);
            roundRect(c, x + PAD - 5, y + 3.5, tw, ROW_H - 7, 4);
            c.fill();
            c.fillStyle = cc;
          } else {
            c.fillStyle = '#c9d3e6';
          }
          clipText(c, s, x + PAD, y + ROW_H / 2, w - PAD * 2);
        }
        painted++;
      }
    }
    this.lastPainted = painted;

    // ---- vertical rules
    c.strokeStyle = '#151a25';
    c.lineWidth = 1;
    c.beginPath();
    for (let ci = c0; ci <= c1 + 1 && ci < xs.length; ci++) {
      const x = Math.round(xs[ci] - sl) + 0.5;
      c.moveTo(x, HEAD_H);
      c.lineTo(x, this.h);
    }
    c.stroke();

    // ---- header
    const g = c.createLinearGradient(0, 0, 0, HEAD_H);
    g.addColorStop(0, '#141926');
    g.addColorStop(1, '#0e1219');
    c.fillStyle = g;
    c.fillRect(0, 0, this.w, HEAD_H);
    c.strokeStyle = '#232c3d';
    c.beginPath();
    c.moveTo(0, HEAD_H - 0.5);
    c.lineTo(this.w, HEAD_H - 0.5);
    c.stroke();

    c.font = '600 11px Inter, system-ui, sans-serif';
    for (let ci = c0; ci <= c1; ci++) {
      const col = t.cols[ci];
      const x = xs[ci] - sl;
      const w = this.widths[ci];
      const sorted = this.host.sortCol === ci;

      if (sorted) {
        c.fillStyle = 'rgba(77,208,255,.09)';
        c.fillRect(x, 0, w, HEAD_H);
      }
      if (ci === this.hoverCol && this.hoverRow < 0) {
        c.fillStyle = 'rgba(255,255,255,.04)';
        c.fillRect(x, 0, w, HEAD_H);
      }

      // kind dot
      const kc = col.kind === 'num' ? '#4dd0ff'
        : col.kind === 'cat' ? '#a06bff'
        : col.kind === 'date' ? '#37e2a0' : '#ffb347';
      c.fillStyle = kc;
      c.beginPath();
      c.arc(x + PAD + 1, HEAD_H / 2, 2.5, 0, Math.PI * 2);
      c.fill();

      c.fillStyle = sorted ? '#4dd0ff' : '#c2ccdd';
      clipText(c, col.name, x + PAD + 9, HEAD_H / 2, w - PAD * 2 - 20);

      if (sorted) {
        const ax = x + w - 12;
        const ay = HEAD_H / 2;
        c.strokeStyle = '#4dd0ff';
        c.lineWidth = 1.6;
        c.beginPath();
        if (this.host.sortDir === 1) { c.moveTo(ax - 3.5, ay + 2); c.lineTo(ax, ay - 2.5); c.lineTo(ax + 3.5, ay + 2); }
        else { c.moveTo(ax - 3.5, ay - 2); c.lineTo(ax, ay + 2.5); c.lineTo(ax + 3.5, ay - 2); }
        c.stroke();
      }

      c.strokeStyle = '#232c3d';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(Math.round(x + w) + 0.5, 4);
      c.lineTo(Math.round(x + w) + 0.5, HEAD_H - 4);
      c.stroke();
    }

    c.restore();
  }
}

function clipText(c: CanvasRenderingContext2D, s: string, x: number, y: number, max: number) {
  if (max <= 8) return;
  const m = c.measureText(s).width;
  if (m <= max) { c.fillText(s, x, y); return; }
  // binary search the longest fitting prefix — cheaper than char-by-char
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.measureText(s.slice(0, mid)).width + 6 <= max) lo = mid;
    else hi = mid - 1;
  }
  c.fillText(s.slice(0, lo) + '…', x, y);
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export function cellText(col: Column, row: number): string {
  const v = col.data[row];
  if (col.kind === 'cat') return v === NULL_CODE ? '—' : col.dict![v] ?? '';
  if (col.kind === 'bool') return v === 2 ? '—' : v === 1 ? 'true' : 'false';
  if (col.kind === 'date') return fmtDate(v);
  return compact(v, col.isInt);
}
