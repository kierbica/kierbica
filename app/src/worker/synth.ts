/**
 * Deterministic synthetic dataset: global commerce + delivery telemetry.
 *
 * The generator deliberately bakes in correlations (channel drives revenue,
 * region drives margin, device drives latency tails, rating drives returns) so
 * that slicing the data actually reveals structure instead of uniform noise.
 */
import type { ColumnMeta, TableWire } from '../types';
import { NULL_CODE } from '../types';

export function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = ['North America', 'Europe', 'APAC', 'LATAM', 'MEA', 'Oceania'];
const COUNTRY: Record<string, string[]> = {
  'North America': ['United States', 'Canada', 'Mexico'],
  Europe: ['Germany', 'France', 'United Kingdom', 'Spain', 'Poland', 'Sweden'],
  APAC: ['Japan', 'Singapore', 'India', 'South Korea', 'Philippines', 'Vietnam'],
  LATAM: ['Brazil', 'Argentina', 'Chile', 'Colombia'],
  MEA: ['UAE', 'South Africa', 'Egypt', 'Kenya'],
  Oceania: ['Australia', 'New Zealand'],
};
const CATEGORY = [
  'Electronics', 'Apparel', 'Home & Garden', 'Sports', 'Beauty',
  'Grocery', 'Toys', 'Automotive',
];
const CHANNEL = ['Organic', 'Paid Search', 'Social', 'Email', 'Affiliate', 'Direct'];
const DEVICE = ['Desktop', 'Mobile', 'Tablet'];
const TIER = ['Free', 'Plus', 'Pro', 'Enterprise'];
const CAMPAIGN = [
  'none', 'spring-launch', 'q3-retarget', 'brand-always-on', 'flash-48h',
  'loyalty-drop', 'creator-collab', 'clearance', 'back-to-school',
  'holiday-preroll', 'winback', 'referral',
];
const STATUS = ['delivered', 'in_transit', 'processing', 'cancelled', 'returned'];

/** Category -> [price mean, price sigma, base margin] */
const CAT_PRICE: [number, number, number][] = [
  [420, 0.85, 0.18], [58, 0.6, 0.46], [130, 0.7, 0.32], [92, 0.65, 0.35],
  [34, 0.5, 0.58], [22, 0.45, 0.14], [41, 0.55, 0.4], [180, 0.8, 0.24],
];
const CHANNEL_LIFT = [1.0, 1.22, 0.86, 1.14, 0.95, 1.08];
const REGION_MARGIN = [1.0, 0.94, 1.11, 0.88, 0.83, 1.05];
const DEVICE_LAT = [38, 96, 61];

function gauss(r: () => number) {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pick(r: () => number, n: number) {
  return Math.min(n - 1, (r() * n) | 0);
}

/** Skewed pick: favours lower indices. */
function zipf(r: () => number, n: number, s = 1.4) {
  return Math.min(n - 1, Math.floor(Math.pow(r(), s) * n));
}

export function synthesize(
  rows: number,
  seed: number,
  onProgress: (pct: number) => void,
): TableWire {
  const t0 = performance.now();
  const r = mulberry32(seed >>> 0);

  const countries: string[] = [];
  const countryOfRegion: number[][] = REGIONS.map((rg) =>
    COUNTRY[rg].map((c) => {
      const i = countries.indexOf(c);
      if (i >= 0) return i;
      countries.push(c);
      return countries.length - 1;
    }),
  );

  const ts = new Float64Array(rows);
  const region = new Uint32Array(rows);
  const country = new Uint32Array(rows);
  const category = new Uint32Array(rows);
  const channel = new Uint32Array(rows);
  const device = new Uint32Array(rows);
  const tier = new Uint32Array(rows);
  const campaign = new Uint32Array(rows);
  const status = new Uint32Array(rows);
  const revenue = new Float64Array(rows);
  const units = new Float64Array(rows);
  const discount = new Float64Array(rows);
  const margin = new Float64Array(rows);
  const latency = new Float64Array(rows);
  const rating = new Float64Array(rows);
  const shipDays = new Float64Array(rows);
  const returned = new Uint8Array(rows);
  const newCustomer = new Uint8Array(rows);
  const customer = new Float64Array(rows);

  // 24 months ending "now", with weekday + seasonal shape.
  const end = Date.UTC(2026, 8, 1);
  const span = 730 * 86400000;
  const custPool = Math.max(500, (rows / 7) | 0);

  const step = Math.max(1, (rows / 100) | 0);
  for (let i = 0; i < rows; i++) {
    if (i % step === 0) onProgress(i / rows);

    // temporal shape: seasonal swell + weekend dip
    let t = end - span + r() * span;
    const d = new Date(t);
    const dow = d.getUTCDay();
    if ((dow === 0 || dow === 6) && r() < 0.28) t = end - span + r() * span;
    const seasonal = 1 + 0.35 * Math.sin(((t - end) / span) * Math.PI * 4);
    ts[i] = t;

    const rg = zipf(r, REGIONS.length, 1.25);
    region[i] = rg;
    const pool = countryOfRegion[rg];
    country[i] = pool[pick(r, pool.length)];

    const cat = zipf(r, CATEGORY.length, 1.15);
    category[i] = cat;
    const ch = zipf(r, CHANNEL.length, 1.1);
    channel[i] = ch;
    const dv = r() < 0.58 ? 1 : r() < 0.75 ? 0 : 2;
    device[i] = dv;
    tier[i] = zipf(r, TIER.length, 1.6);
    campaign[i] = ch === 0 ? 0 : zipf(r, CAMPAIGN.length, 0.9);

    const [pMean, pSig, baseMargin] = CAT_PRICE[cat];
    const price = Math.max(1, pMean * Math.exp(gauss(r) * pSig));
    const q = 1 + Math.floor(Math.pow(r(), 2.6) * 9);
    units[i] = q;

    const disc = r() < 0.42 ? Math.round(r() * 40) / 100 : 0;
    discount[i] = disc;

    const rev = price * q * (1 - disc) * CHANNEL_LIFT[ch] * seasonal;
    revenue[i] = Math.round(rev * 100) / 100;

    const m = baseMargin * REGION_MARGIN[rg] * (1 - disc * 1.35) + gauss(r) * 0.05;
    margin[i] = Math.round(Math.max(-0.4, Math.min(0.82, m)) * 1000) / 1000;

    // log-normal latency with a device-dependent tail
    latency[i] = Math.round(DEVICE_LAT[dv] * Math.exp(Math.abs(gauss(r)) * 0.55) * 10) / 10;

    const baseRating = 4.35 - (dv === 1 ? 0.12 : 0) - disc * 0.4 + gauss(r) * 0.55;
    const rt = Math.max(1, Math.min(5, baseRating));
    rating[i] = r() < 0.045 ? NaN : Math.round(rt * 10) / 10;

    const sd = Math.max(1, Math.round(2 + Math.abs(gauss(r)) * 3 + (rg === 4 ? 3 : 0)));
    shipDays[i] = sd;

    const pReturn = 0.03 + (rt < 3 ? 0.22 : 0) + (cat === 1 ? 0.09 : 0) + disc * 0.05;
    const ret = r() < pReturn;
    returned[i] = ret ? 1 : 0;
    newCustomer[i] = r() < 0.31 ? 1 : 0;

    status[i] = ret ? 4 : r() < 0.72 ? 0 : r() < 0.86 ? 1 : r() < 0.97 ? 2 : 3;
    customer[i] = 100000 + ((r() * custPool) | 0);
  }
  onProgress(1);

  const cols: ColumnMeta[] = [];
  const buffers: ArrayBuffer[] = [];

  const addNum = (name: string, data: Float64Array, isInt: boolean, kind: 'num' | 'date' = 'num') => {
    let min = Infinity;
    let max = -Infinity;
    let nulls = 0;
    for (let i = 0; i < rows; i++) {
      const v = data[i];
      if (Number.isNaN(v)) { nulls++; continue; }
      if (v < min) min = v;
      if (v > max) max = v;
    }
    cols.push({ name, kind, min, max, nulls, cardinality: 0, isInt, spark: spark(data, rows, min, max) });
    buffers.push(data.buffer as ArrayBuffer);
  };
  const addCat = (name: string, data: Uint32Array, dict: string[]) => {
    const c = new Float64Array(dict.length);
    for (let i = 0; i < rows; i++) if (data[i] !== NULL_CODE) c[data[i]]++;
    cols.push({
      name, kind: 'cat', min: 0, max: dict.length - 1, nulls: 0,
      cardinality: dict.length, isInt: true, dict,
      spark: Array.from(c, (v) => v).map((v) => v / Math.max(1, Math.max(...c))),
    });
    buffers.push(data.buffer as ArrayBuffer);
  };
  const addBool = (name: string, data: Uint8Array) => {
    let t = 0;
    for (let i = 0; i < rows; i++) if (data[i] === 1) t++;
    cols.push({
      name, kind: 'bool', min: 0, max: 1, nulls: 0, cardinality: 2, isInt: true,
      spark: [(rows - t) / rows, t / rows],
    });
    buffers.push(data.buffer as ArrayBuffer);
  };

  addNum('order_ts', ts, false, 'date');
  addCat('region', region, REGIONS);
  addCat('country', country, countries);
  addCat('category', category, CATEGORY);
  addCat('channel', channel, CHANNEL);
  addCat('device', device, DEVICE);
  addCat('plan_tier', tier, TIER);
  addCat('campaign', campaign, CAMPAIGN);
  addCat('status', status, STATUS);
  addNum('revenue', revenue, false);
  addNum('units', units, true);
  addNum('discount', discount, false);
  addNum('margin', margin, false);
  addNum('latency_ms', latency, false);
  addNum('rating', rating, false);
  addNum('ship_days', shipDays, true);
  addBool('returned', returned);
  addBool('new_customer', newCustomer);
  addNum('customer_id', customer, true);

  let bytes = 0;
  for (const b of buffers) bytes += b.byteLength;

  return {
    name: `telemetry_${(rows / 1000) | 0}k`,
    nrows: rows,
    cols,
    buffers,
    bytes,
    ms: performance.now() - t0,
  };
}

/** 40-bin normalised distribution used for the field-list sparklines. */
export function spark(data: Float64Array, n: number, min: number, max: number): number[] {
  const B = 40;
  const out = new Float64Array(B);
  if (!(max > min)) return Array.from(out);
  const k = B / (max - min);
  const stride = n > 200000 ? Math.ceil(n / 200000) : 1;
  for (let i = 0; i < n; i += stride) {
    const v = data[i];
    if (Number.isNaN(v)) continue;
    let b = ((v - min) * k) | 0;
    if (b < 0) b = 0;
    if (b >= B) b = B - 1;
    out[b]++;
  }
  let mx = 0;
  for (let i = 0; i < B; i++) if (out[i] > mx) mx = out[i];
  if (mx === 0) return Array.from(out);
  return Array.from(out, (v) => Math.pow(v / mx, 0.6));
}
