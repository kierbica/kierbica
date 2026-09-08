/**
 * Canvas2D chart primitives: bar, line/area, histogram, heatmap.
 * All draw from typed arrays and support hover hit-testing without any
 * per-datum DOM. Animation uses a single eased progress value.
 */
import { color, compact, ticks } from '../fmt';

export interface ChartHit { i: number; x: number; y: number; label: string; value: number; }

const AX = '#5d6a80';
const GRID = '#161b26';

export interface Frame { l: number; r: number; t: number; b: number; w: number; h: number; }

export function frame(w: number, h: number, left = 62, bottom = 34): Frame {
  const l = left;
  const t = 14;
  const r = w - 16;
  const b = h - bottom;
  return { l, r, t, b, w: r - l, h: b - t };
}

export function clear(c: CanvasRenderingContext2D, w: number, h: number) {
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#0a0d14';
  roundRect(c, 0, 0, w, h, 8);
  c.fill();
}

export function axes(
  c: CanvasRenderingContext2D, f: Frame, yLo: number, yHi: number,
  yFmt: (v: number) => string, title?: string,
) {
  const tk = ticks(yLo, yHi, 5);
  c.font = '10px ui-monospace, monospace';
  c.textBaseline = 'middle';
  c.textAlign = 'right';
  c.lineWidth = 1;
  for (const t of tk) {
    if (t < yLo - 1e-9 || t > yHi + 1e-9) continue;
    const y = Math.round(f.b - ((t - yLo) / (yHi - yLo || 1)) * f.h) + 0.5;
    c.strokeStyle = GRID;
    c.beginPath();
    c.moveTo(f.l, y);
    c.lineTo(f.r, y);
    c.stroke();
    c.fillStyle = AX;
    c.fillText(yFmt(t), f.l - 7, y);
  }
  c.textAlign = 'left';
  if (title) {
    c.fillStyle = '#97a3b8';
    c.font = '600 11px Inter, system-ui, sans-serif';
    c.fillText(title, f.l, 8);
  }
}

/** Vertical bars with hover hit-testing. */
export function bars(
  c: CanvasRenderingContext2D, f: Frame,
  values: Float64Array, labels: string[], anim: number,
  hover: number, colorBy: 'index' | 'accent' = 'accent',
): ChartHit[] {
  const n = values.length;
  if (n === 0) return [];
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v > hi) hi = v;
    if (v < lo) lo = v;
  }
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.08;
  hi += pad;
  if (lo < 0) lo -= pad;

  axes(c, f, lo, hi, (v) => compact(v));

  const step = f.w / n;
  // Cap the bar width so a handful of groups don't render as giant slabs.
  const bw = Math.max(1, Math.min(step - 2, step * 0.82, 96));
  const zero = f.b - ((0 - lo) / (hi - lo)) * f.h;
  const hits: ChartHit[] = [];

  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const x = f.l + i * step + (step - bw) / 2;
    const y = f.b - ((v - lo) / (hi - lo)) * f.h;
    const top = Math.min(y, zero);
    const hgt = Math.abs(zero - y) * anim;
    const yy = v >= 0 ? zero - hgt : zero;

    const isH = i === hover;
    const base = colorBy === 'index' ? color(i) : '#4dd0ff';
    if (isH) {
      c.fillStyle = '#ffffff';
      c.globalAlpha = 0.13;
      c.fillRect(f.l + i * step, f.t, step, f.h);
      c.globalAlpha = 1;
    }
    const g = c.createLinearGradient(0, yy, 0, yy + hgt);
    g.addColorStop(0, isH ? lighten(base) : base);
    g.addColorStop(1, base + '3a');
    c.fillStyle = g;
    roundRect(c, x, yy, bw, Math.max(1, hgt), Math.min(3, bw / 2));
    c.fill();

    hits.push({ i, x: x + bw / 2, y: yy, label: labels[i] ?? String(i), value: v });
    void top;
  }

  // x labels — thinned so they never collide
  c.font = '10px Inter, system-ui, sans-serif';
  c.fillStyle = AX;
  c.textAlign = 'center';
  c.textBaseline = 'top';
  const maxLbl = Math.max(1, Math.floor(f.w / 62));
  const every = Math.ceil(n / maxLbl);
  for (let i = 0; i < n; i += every) {
    const x = f.l + i * step + step / 2;
    const s = trunc(c, labels[i] ?? '', step * every - 6);
    c.fillText(s, x, f.b + 7);
  }
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  return hits;
}

/** Line + gradient area. */
export function line(
  c: CanvasRenderingContext2D, f: Frame,
  values: Float64Array, labels: string[], anim: number, hover: number,
  stroke = '#4dd0ff',
): ChartHit[] {
  const n = values.length;
  if (n === 0) return [];
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v > hi) hi = v;
    if (v < lo) lo = v;
  }
  if (!Number.isFinite(hi)) return [];
  if (hi === lo) { hi = lo + 1; lo -= 1; }
  const pad = (hi - lo) * 0.1;
  hi += pad;
  lo -= pad;

  axes(c, f, lo, hi, (v) => compact(v));

  const xs = (i: number) => f.l + (n === 1 ? f.w / 2 : (i / (n - 1)) * f.w);
  const ys = (v: number) => f.b - ((v - lo) / (hi - lo)) * f.h;
  const cut = Math.max(1, Math.ceil(n * anim));

  // area
  c.beginPath();
  c.moveTo(xs(0), f.b);
  for (let i = 0; i < cut; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    c.lineTo(xs(i), ys(v));
  }
  c.lineTo(xs(cut - 1), f.b);
  c.closePath();
  const g = c.createLinearGradient(0, f.t, 0, f.b);
  g.addColorStop(0, stroke + '4d');
  g.addColorStop(1, stroke + '00');
  c.fillStyle = g;
  c.fill();

  // stroke
  c.beginPath();
  let started = false;
  for (let i = 0; i < cut; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (!started) { c.moveTo(xs(i), ys(v)); started = true; }
    else c.lineTo(xs(i), ys(v));
  }
  c.strokeStyle = stroke;
  c.lineWidth = 1.8;
  c.lineJoin = 'round';
  c.shadowColor = stroke + '80';
  c.shadowBlur = 8;
  c.stroke();
  c.shadowBlur = 0;

  const hits: ChartHit[] = [];
  const dotEvery = n > 90 ? Math.ceil(n / 90) : 1;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    hits.push({ i, x: xs(i), y: ys(v), label: labels[i] ?? '', value: v });
    if (i % dotEvery === 0 && i < cut) {
      c.fillStyle = '#0a0d14';
      c.beginPath();
      c.arc(xs(i), ys(v), 2.6, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = stroke;
      c.beginPath();
      c.arc(xs(i), ys(v), 1.7, 0, Math.PI * 2);
      c.fill();
    }
  }

  if (hover >= 0 && hover < hits.length) {
    const h = hits[hover];
    c.strokeStyle = 'rgba(255,255,255,.2)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(h.x, f.t);
    c.lineTo(h.x, f.b);
    c.stroke();
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(h.x, h.y, 4, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = stroke;
    c.beginPath();
    c.arc(h.x, h.y, 2.4, 0, Math.PI * 2);
    c.fill();
  }

  c.font = '10px Inter, system-ui, sans-serif';
  c.fillStyle = AX;
  c.textAlign = 'center';
  c.textBaseline = 'top';
  const maxLbl = Math.max(2, Math.floor(f.w / 74));
  const every = Math.max(1, Math.ceil(n / maxLbl));
  for (let i = 0; i < n; i += every) c.fillText(trunc(c, labels[i] ?? '', 70), xs(i), f.b + 7);
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  return hits;
}

/** Distribution histogram (no axis labels — used in the compact side panel). */
export function histogram(
  c: CanvasRenderingContext2D, w: number, h: number,
  bins: Float64Array, lo: number, hi: number,
  fmt: (v: number) => string, hover = -1,
) {
  c.clearRect(0, 0, w, h);
  const n = bins.length;
  if (!n) return;
  let mx = 0;
  for (let i = 0; i < n; i++) if (bins[i] > mx) mx = bins[i];
  if (mx === 0) {
    c.fillStyle = '#39435a';
    c.font = '10px Inter, sans-serif';
    c.textAlign = 'center';
    c.fillText('no data in range', w / 2, h / 2);
    c.textAlign = 'left';
    return;
  }
  const bh = h - 15;
  const bw = w / n;
  for (let i = 0; i < n; i++) {
    const v = Math.pow(bins[i] / mx, 0.72);
    const bhh = Math.max(bins[i] > 0 ? 1 : 0, v * bh);
    const g = c.createLinearGradient(0, bh - bhh, 0, bh);
    const hot = i === hover;
    g.addColorStop(0, hot ? '#ffffff' : '#4dd0ff');
    g.addColorStop(1, hot ? '#a06bff' : '#a06bff44');
    c.fillStyle = g;
    c.fillRect(i * bw, bh - bhh, Math.max(0.6, bw - 0.6), bhh);
  }
  c.strokeStyle = '#1e2534';
  c.beginPath();
  c.moveTo(0, bh + 0.5);
  c.lineTo(w, bh + 0.5);
  c.stroke();
  c.font = '9px ui-monospace, monospace';
  c.fillStyle = AX;
  c.textBaseline = 'top';
  c.fillText(fmt(lo), 1, bh + 3);
  c.textAlign = 'right';
  c.fillText(fmt(hi), w - 1, bh + 3);
  c.textAlign = 'left';
  c.textBaseline = 'middle';
}

/** Grouped-matrix heatmap: rows = key A, cols = key B. */
export function heatmap(
  c: CanvasRenderingContext2D, f: Frame,
  m: Float64Array, rows: string[], cols: string[], hoverIdx: number,
): ChartHit[] {
  const R = rows.length;
  const C = cols.length;
  if (!R || !C) return [];
  let mx = 0;
  let mn = Infinity;
  for (let i = 0; i < m.length; i++) {
    const v = m[i];
    if (!Number.isFinite(v)) continue;
    if (v > mx) mx = v;
    if (v < mn) mn = v;
  }
  if (!Number.isFinite(mn)) return [];
  if (mx === mn) mx = mn + 1;

  const cw = f.w / C;
  const ch = f.h / R;
  const hits: ChartHit[] = [];
  for (let r = 0; r < R; r++) {
    for (let k = 0; k < C; k++) {
      const v = m[r * C + k];
      const x = f.l + k * cw;
      const y = f.t + r * ch;
      const idx = r * C + k;
      if (!Number.isFinite(v)) {
        c.fillStyle = '#0d1017';
      } else {
        const t = (v - mn) / (mx - mn);
        c.fillStyle = ramp(t);
      }
      c.fillRect(x, y, Math.max(1, cw - 1), Math.max(1, ch - 1));
      if (idx === hoverIdx) {
        c.strokeStyle = '#fff';
        c.lineWidth = 1.5;
        c.strokeRect(x + 0.5, y + 0.5, cw - 2, ch - 2);
      }
      hits.push({ i: idx, x: x + cw / 2, y: y + ch / 2, label: `${rows[r]} · ${cols[k]}`, value: v });
    }
  }

  c.font = '9.5px Inter, system-ui, sans-serif';
  c.fillStyle = AX;
  c.textAlign = 'right';
  const rowEvery = Math.max(1, Math.ceil(R / Math.floor(f.h / 13)));
  for (let r = 0; r < R; r += rowEvery) {
    c.fillText(trunc(c, rows[r], f.l - 8), f.l - 6, f.t + r * ch + ch / 2);
  }
  c.textAlign = 'center';
  c.textBaseline = 'top';
  const colEvery = Math.max(1, Math.ceil(C / Math.floor(f.w / 58)));
  for (let k = 0; k < C; k += colEvery) {
    c.fillText(trunc(c, cols[k], cw * colEvery - 4), f.l + k * cw + cw / 2, f.b + 6);
  }
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  return hits;
}

/** viridis-ish ramp */
export function ramp(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  const stops: [number, number, number][] = [
    [10, 14, 24], [30, 52, 92], [39, 105, 148], [45, 160, 152],
    [126, 205, 116], [232, 226, 88], [255, 245, 180],
  ];
  const p = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(p));
  const f = p - i;
  const a = stops[i];
  const b = stops[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

export function roundRect(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function trunc(c: CanvasRenderingContext2D, s: string, max: number): string {
  if (max <= 6) return '';
  if (c.measureText(s).width <= max) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.measureText(s.slice(0, mid)).width + 5 <= max) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + '…';
}

function lighten(hex: string): string {
  const h = hex.replace('#', '');
  const r = Math.min(255, parseInt(h.slice(0, 2), 16) + 60);
  const g = Math.min(255, parseInt(h.slice(2, 4), 16) + 60);
  const b = Math.min(255, parseInt(h.slice(4, 6), 16) + 60);
  return `rgb(${r},${g},${b})`;
}

/** Nearest-hit lookup for pointer interaction. */
export function nearest(hits: ChartHit[], x: number, y: number, mode: 'x' | 'xy' = 'x'): number {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < hits.length; i++) {
    const dx = hits[i].x - x;
    const dy = hits[i].y - y;
    const d = mode === 'x' ? Math.abs(dx) : dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
