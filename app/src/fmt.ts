/** Formatting helpers shared across grid, charts and panels. */

export function compact(v: number, isInt = false): string {
  if (Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '-∞';
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  if (isInt || Number.isInteger(v)) return v.toLocaleString('en-US');
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  if (a === 0) return '0';
  return v.toExponential(1);
}

export function int(v: number): string {
  return Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—';
}

export function bytes(b: number): string {
  if (b >= 1 << 30) return (b / (1 << 30)).toFixed(2) + ' GB';
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
  if (b >= 1 << 10) return (b / (1 << 10)).toFixed(0) + ' KB';
  return b + ' B';
}

export function ms(v: number): string {
  if (v < 1) return v.toFixed(2) + 'ms';
  if (v < 1000) return v.toFixed(1) + 'ms';
  return (v / 1000).toFixed(2) + 's';
}

const DFMT = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
});

export function date(v: number): string {
  if (Number.isNaN(v)) return '—';
  return DFMT.format(new Date(v)).replace(',', '');
}

export function dateShort(v: number): string {
  if (Number.isNaN(v)) return '—';
  return new Date(v).toISOString().slice(0, 10);
}

/** Nice axis ticks (1/2/5 * 10^n). */
export function ticks(lo: number, hi: number, target = 5): number[] {
  if (!(hi > lo)) return [lo];
  const span = hi - lo;
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(t);
  return out;
}

/** Categorical palette — perceptually distinct on a dark background. */
export const PALETTE = [
  '#4dd0ff', '#a06bff', '#37e2a0', '#ffb347', '#ff5f6d', '#5fa8ff',
  '#ff8fd0', '#8de06a', '#ffe066', '#6be3e3', '#c98bff', '#ff9a5a',
  '#7ce8c4', '#ff7ab8', '#9ecbff', '#d4e05f', '#68d8ff', '#b8a1ff',
];

export function color(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export function hexRGB(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}
