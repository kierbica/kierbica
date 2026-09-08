/**
 * Nebula — an in-browser data studio.
 *
 * Architecture:
 *   worker/   columnar store + query engine (no DOM, owns the data)
 *   ui/       canvas renderers (grid, charts, WebGL scatter)
 *   state.ts  coalesced query dispatch
 *   main.ts   shell, panels, interaction, render loop
 *
 * The main thread never iterates the dataset: it only ever touches the result
 * index and the aggregate arrays the worker hands back.
 */
import './style.css';
import { Store, type View } from './state';
import type { AggFn, Column, Filter } from './types';
import { NULL_CODE } from './types';
import { DataGrid } from './ui/grid';
import { ScatterGL } from './ui/scatter';
import * as C from './ui/charts';
import { $, debounce, el, esc, icon, on } from './ui/dom';
import { bytes, color, compact, date as fmtDate, dateShort, int, ms, ticks } from './fmt';

const store = new Store();
const app = $('#app');

// ------------------------------------------------------------------ shell
app.innerHTML = `
<header class="head">
  <div class="brand">
    <div class="brand-mark"></div>
    <div class="brand-name">Nebula</div>
    <div class="brand-sub">data studio</div>
  </div>
  <div class="head-sep"></div>
  <button class="hbtn" id="btnLeft" title="Toggle fields panel (F)">${icon('left')}</button>
  <button class="hbtn" id="btnLoad" title="Load a CSV file">${icon('upload')}<span class="wide-only">Load CSV</span></button>
  <button class="hbtn" id="btnGen" title="Generate a synthetic dataset">${icon('dice')}<span class="wide-only">Generate</span></button>
  <button class="hbtn" id="btnClear" title="Clear all filters (C)">${icon('reset')}<span class="wide-only">Reset</span></button>
  <div class="spacer"></div>
  <div class="stat-pill" id="pill">
    <div class="pulse" id="pulse"></div>
    <span id="pillRows">—</span>
  </div>
  <button class="hbtn primary" id="btnCmd">${icon('cmd')}<span class="wide-only">Command</span><span class="kbd">⌘K</span></button>
  <button class="hbtn" id="btnExport" title="Export the current view as CSV">${icon('download')}</button>
  <button class="hbtn" id="btnRight" title="Toggle insights panel (I)">${icon('right')}</button>
</header>

<aside class="side">
  <div class="panel-h">Fields <span class="cnt" id="fieldCnt"></span></div>
  <div class="search-wrap"><input class="search" id="fieldSearch" placeholder="Filter fields…" spellcheck="false" /></div>
  <div class="scrollarea" id="fieldList"></div>
  <div class="panel-h">Filters <button id="clearF">clear</button></div>
  <div class="filters" id="filterList" style="max-height:44%;overflow-y:auto"></div>
</aside>

<main class="main">
  <div class="tabs" id="tabs">
    <button class="tab on" data-v="grid">${icon('table')} Table</button>
    <button class="tab" data-v="bars">${icon('chart')} Breakdown</button>
    <button class="tab" data-v="trend">${icon('zap')} Trend</button>
    <button class="tab" data-v="scatter">${icon('scatter')} Scatter <span class="kbd" id="glTag">GPU</span></button>
    <button class="tab" data-v="matrix">${icon('grid4')} Matrix</button>
  </div>

  <section class="view on" id="v-grid"><div class="gridwrap" id="gridwrap"></div></section>

  <section class="view" id="v-bars">
    <div class="vbar">
      <label>Group</label><select class="sel" id="barGroup"></select>
      <label>Metric</label><select class="sel" id="barFn"></select>
      <select class="sel" id="barCol"></select>
      <div class="seg" id="barSort">
        <button data-s="value" class="on">by value</button>
        <button data-s="label">A–Z</button>
      </div>
      <span class="spacer"></span>
      <span id="barNote" style="font-family:var(--mono);font-size:10px;color:var(--txt-3)"></span>
    </div>
    <div class="chartwrap"><canvas id="cBars"></canvas></div>
  </section>

  <section class="view" id="v-trend">
    <div class="vbar">
      <label>Over</label><select class="sel" id="trGroup"></select>
      <label>Bins</label><input type="range" id="trBins" min="6" max="180" value="48" style="width:110px" />
      <span id="trBinsN" style="font-family:var(--mono);font-size:11px;color:var(--txt-2);width:26px"></span>
      <label>Metric</label><select class="sel" id="trFn"></select>
      <select class="sel" id="trCol"></select>
    </div>
    <div class="chartwrap"><canvas id="cTrend"></canvas></div>
  </section>

  <section class="view" id="v-scatter">
    <div class="vbar">
      <label>X</label><select class="sel" id="scX"></select>
      <button class="hbtn" id="scLogX" title="Log scale on X">log</button>
      <label>Y</label><select class="sel" id="scY"></select>
      <button class="hbtn" id="scLogY" title="Log scale on Y">log</button>
      <label>Colour</label><select class="sel" id="scC"></select>
      <label>Size</label><input type="range" id="scSize" min="1" max="9" step="0.5" value="2.5" style="width:70px" />
      <label>Alpha</label><input type="range" id="scAlpha" min="5" max="100" value="55" style="width:70px" />
      <button class="hbtn" id="scReset">reset</button>
      <span class="spacer"></span>
      <span id="scNote" style="font-family:var(--mono);font-size:10px;color:var(--txt-3)"></span>
    </div>
    <div class="chartwrap" id="scWrap">
      <canvas id="cScatter"></canvas>
      <canvas id="cScatterAx" style="pointer-events:none"></canvas>
    </div>
  </section>

  <section class="view" id="v-matrix">
    <div class="vbar">
      <label>Rows</label><select class="sel" id="mxA"></select>
      <label>Cols</label><select class="sel" id="mxB"></select>
      <label>Metric</label><select class="sel" id="mxFn"></select>
      <select class="sel" id="mxCol"></select>
      <span class="spacer"></span>
      <span id="mxNote" style="font-family:var(--mono);font-size:10px;color:var(--txt-3)"></span>
    </div>
    <div class="chartwrap"><canvas id="cMatrix"></canvas></div>
  </section>
</main>

<aside class="right">
  <div class="panel-h">Insights</div>
  <div class="scrollarea">
    <div class="statgrid" id="statGrid"></div>
    <div class="panel-h">Distribution <span class="cnt" id="distName"></span></div>
    <div class="dist"><canvas id="cDist"></canvas></div>
    <div class="panel-h">Top values <span class="cnt" id="topName"></span></div>
    <div class="topk" id="topk"></div>
  </div>
</aside>

<footer class="foot">
  <span>rows <b id="fRows">0</b></span>
  <span>query <b id="fQuery" class="hi">—</b></span>
  <span>frame <b id="fFrame">—</b></span>
  <span>mem <b id="fMem">—</b></span>
  <span class="spacer" style="flex:1"></span>
  <canvas class="fps-c" id="fpsC" width="108" height="26"></canvas>
  <span><b id="fFps" class="ok">60</b> fps</span>
</footer>`;

// ------------------------------------------------------------------ toasts
const toasts = $('#toasts');
function toast(msg: string, kind: 'ok' | 'err' | '' = '') {
  const t = el('div', `toast ${kind}`, esc(msg));
  toasts.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s, transform .3s';
    t.style.opacity = '0';
    t.style.transform = 'translateX(20px)';
    setTimeout(() => t.remove(), 320);
  }, 3200);
}

// ------------------------------------------------------------------ tooltip
const tip = $('#tip');
function showTip(x: number, y: number, title: string, rows: [string, string][]) {
  tip.innerHTML =
    `<div class="t-t">${esc(title)}</div>` +
    rows.map(([k, v]) => `<div class="t-r"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
  tip.classList.add('on');
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(x + 14, window.innerWidth - r.width - 10) + 'px';
  tip.style.top = Math.min(y + 14, window.innerHeight - r.height - 10) + 'px';
}
const hideTip = () => tip.classList.remove('on');

// ------------------------------------------------------------------ grid
const gridwrap = $('#gridwrap');
const grid = new DataGrid(gridwrap, {
  get table() { return store.state.table; },
  get index() { return store.state.result?.index ?? new Uint32Array(0); },
  get matched() { return store.state.result?.matched ?? 0; },
  get sortCol() { return store.state.sort?.col ?? -1; },
  get sortDir() { return store.state.sort?.dir ?? -1; },
  onSort: (c) => store.setSort(c),
  onHeaderMenu: (c) => focusField(c),
});

// ------------------------------------------------------------------ canvases
const cBars = $<HTMLCanvasElement>('#cBars');
const cTrend = $<HTMLCanvasElement>('#cTrend');
const cScatter = $<HTMLCanvasElement>('#cScatter');
const cMatrix = $<HTMLCanvasElement>('#cMatrix');
const cDist = $<HTMLCanvasElement>('#cDist');
const scatter = new ScatterGL(cScatter);
if (!scatter.ok) $('#glTag').textContent = 'CPU';

const ctx2d = (cv: HTMLCanvasElement) => cv.getContext('2d')!;

// ------------------------------------------------------------------ helpers
const S = () => store.state;
const cols = () => S().table?.cols ?? [];
const colName = (i: number) => cols()[i]?.name ?? '—';

function isNum(c: Column) { return c.kind === 'num' || c.kind === 'date'; }

function optionsFor(sel: HTMLSelectElement, pred: (c: Column) => boolean, value: number, allowNone = false) {
  const t = S().table;
  sel.innerHTML =
    (allowNone ? '<option value="-1">— none —</option>' : '') +
    (t ? t.cols.map((c, i) => (pred(c) ? `<option value="${i}">${esc(c.name)}</option>` : '')).join('') : '');
  sel.value = String(value);
}

const AGGS: AggFn[] = ['sum', 'avg', 'count', 'min', 'max', 'median'];
function aggOptions(sel: HTMLSelectElement, v: AggFn) {
  sel.innerHTML = AGGS.map((a) => `<option value="${a}">${a}</option>`).join('');
  sel.value = v;
}

// ------------------------------------------------------------------ field list
const fieldList = $('#fieldList');
const fieldSearch = $<HTMLInputElement>('#fieldSearch');
let fieldQuery = '';

function kindTag(k: string) {
  return k === 'num' ? '#' : k === 'cat' ? 'A' : k === 'date' ? 'T' : 'B';
}

function renderFields() {
  const t = S().table;
  if (!t) { fieldList.innerHTML = ''; return; }
  const q = fieldQuery.toLowerCase();
  const items = t.cols.map((c, i) => ({ c, i })).filter((x) => !q || x.c.name.toLowerCase().includes(q));
  $('#fieldCnt').textContent = `${items.length}/${t.cols.length}`;

  fieldList.innerHTML = items.map(({ c, i }) => {
    const meta =
      c.kind === 'cat' ? `${int(c.cardinality)} values`
      : c.kind === 'bool' ? 'boolean'
      : c.kind === 'date' ? `${dateShort(c.min)} → ${dateShort(c.max)}`
      : `${compact(c.min, c.isInt)} … ${compact(c.max, c.isInt)}`;
    const nulls = c.nulls ? ` · ${((c.nulls / t.nrows) * 100).toFixed(1)}% null` : '';
    return `
      <div class="field ${S().focusCol === i ? 'active' : ''}" data-i="${i}" title="${esc(c.name)}">
        <div class="field-ico k-${c.kind}">${kindTag(c.kind)}</div>
        <div class="field-body">
          <div class="field-name">${esc(c.name)}</div>
          <div class="field-meta">${esc(meta)}${nulls}</div>
        </div>
        ${sparkSVG(c)}
        <div class="field-acts">
          <button class="mini" data-act="filter" data-i="${i}" title="Add filter">${icon('filter')}</button>
          <button class="mini" data-act="sort" data-i="${i}" title="Sort by this field">${icon('sort')}</button>
        </div>
      </div>`;
  }).join('');
}

function sparkSVG(c: Column): string {
  const s = c.spark ?? [];
  if (!s.length) return '<svg class="spark"></svg>';
  const w = 62;
  const h = 17;
  const bw = w / s.length;
  const fill = c.kind === 'num' ? '#4dd0ff' : c.kind === 'cat' ? '#a06bff' : c.kind === 'date' ? '#37e2a0' : '#ffb347';
  const bars = s.map((v, i) => {
    const bh = Math.max(v > 0 ? 1 : 0, v * (h - 1));
    return `<rect x="${(i * bw).toFixed(2)}" y="${(h - bh).toFixed(2)}" width="${Math.max(0.6, bw - 0.35).toFixed(2)}" height="${bh.toFixed(2)}" fill="${fill}" opacity="${0.35 + v * 0.6}"/>`;
  }).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>`;
}

on(fieldSearch, 'input', debounce(() => { fieldQuery = fieldSearch.value; renderFields(); }, 90));

on(fieldList, 'click', (e: MouseEvent) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (btn) {
    const i = +btn.dataset.i!;
    if (btn.dataset.act === 'filter') addFilterFor(i);
    else store.setSort(i);
    e.stopPropagation();
    return;
  }
  const f = (e.target as HTMLElement).closest<HTMLElement>('.field');
  if (f) focusField(+f.dataset.i!);
});

function focusField(i: number) {
  const c = cols()[i];
  store.patch({ focusCol: i, histCol: c && isNum(c) ? i : S().histCol }, true);
  renderFields();
}

// ------------------------------------------------------------------ filters
const filterList = $('#filterList');

function addFilterFor(col: number) {
  const c = cols()[col];
  if (!c) return;
  const existing = S().filters.find((f) => f.col === col);
  if (existing) { flashFilter(existing.id); return; }
  const id = `f${col}_${Date.now().toString(36)}`;
  // A new filter starts as a no-op (everything selected / full range) so adding
  // one never makes the view go blank — you narrow from there.
  const allCodes =
    c.kind === 'bool' ? [0, 1, 2] : Array.from({ length: c.cardinality }, (_, i) => i);
  const f: Filter =
    c.kind === 'cat' || c.kind === 'bool'
      ? { id, col, op: 'in', set: allCodes, enabled: true }
      : { id, col, op: 'range', lo: c.min, hi: c.max, enabled: true };
  store.setFilter(f);
  renderFilters();
  requestAnimationFrame(() => flashFilter(id));
}

function flashFilter(id: string) {
  const n = filterList.querySelector<HTMLElement>(`[data-fid="${id}"]`);
  if (!n) return;
  n.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  n.animate(
    [{ boxShadow: '0 0 0 0 rgba(77,208,255,.55)' }, { boxShadow: '0 0 0 7px rgba(77,208,255,0)' }],
    { duration: 620, easing: 'ease-out' },
  );
}

function renderFilters() {
  const fs = S().filters;
  if (!fs.length) {
    filterList.innerHTML = `<div class="empty">${icon('filter')}<div>No filters yet.</div><div style="opacity:.7">Hover a field and hit the funnel, or press <span class="kbd">⌘K</span>.</div></div>`;
    return;
  }
  filterList.innerHTML = fs.map((f) => {
    const c = cols()[f.col];
    if (!c) return '';
    return `
      <div class="fchip ${f.enabled ? '' : 'off'}" data-fid="${f.id}">
        <div class="fchip-h" data-toggle="${f.id}">
          <div class="cbx ${f.enabled ? 'on' : ''}"></div>
          <span class="fchip-name">${esc(c.name)}</span>
          <span class="fchip-op">${f.op}</span>
          <button class="fchip-x" data-del="${f.id}">×</button>
        </div>
        <div class="fchip-sum">${esc(summary(f, c))}</div>
        <div class="fchip-b" data-body="${f.id}"></div>
      </div>`;
  }).join('');

  for (const f of fs) {
    const body = filterList.querySelector<HTMLElement>(`[data-body="${f.id}"]`);
    const c = cols()[f.col];
    if (!body || !c) continue;
    if (f.op === 'range') buildRange(body, f, c);
    else buildChecklist(body, f, c);
  }
}

function summary(f: Filter, c: Column): string {
  if (f.op === 'range') {
    const fmt = (v: number) => (c.kind === 'date' ? dateShort(v) : compact(v, c.isInt));
    return `${fmt(f.lo ?? c.min)} → ${fmt(f.hi ?? c.max)}`;
  }
  if (f.op === 'in') {
    const n = f.set?.length ?? 0;
    const total = c.kind === 'bool' ? 3 : c.cardinality;
    if (n === 0) return 'nothing selected — matches none';
    if (n >= total) return `all ${total} values`;
    if (c.kind === 'bool') return f.set!.map((v) => (v === 1 ? 'true' : v === 0 ? 'false' : 'null')).join(', ');
    if (n <= 3) return f.set!.map((v) => c.dict?.[v] ?? '?').join(', ');
    return `${n} of ${total} selected`;
  }
  return f.text ?? '';
}

on(filterList, 'click', (e: MouseEvent) => {
  const t = e.target as HTMLElement;
  const del = t.closest<HTMLElement>('[data-del]');
  if (del) { store.removeFilter(del.dataset.del!); renderFilters(); return; }
  const tog = t.closest<HTMLElement>('[data-toggle]');
  if (tog) { store.toggleFilter(tog.dataset.toggle!); renderFilters(); }
});

/** Dual-handle range slider with a live histogram behind it. */
function buildRange(host: HTMLElement, f: Filter, c: Column) {
  const spark = c.spark ?? [];
  host.innerHTML = `
    <div class="rs">
      <div class="rs-hist">${spark.map((v) => `<i style="height:${Math.max(1, v * 12).toFixed(1)}px"></i>`).join('')}</div>
      <div class="rs-track"></div><div class="rs-fill"></div>
      <div class="rs-h" data-h="lo"></div><div class="rs-h" data-h="hi"></div>
    </div>
    <div class="rs-lbl"><span data-l="lo"></span><span data-l="hi"></span></div>`;

  const wrap = host.querySelector<HTMLElement>('.rs')!;
  const fill = host.querySelector<HTMLElement>('.rs-fill')!;
  const hLo = host.querySelector<HTMLElement>('[data-h="lo"]')!;
  const hHi = host.querySelector<HTMLElement>('[data-h="hi"]')!;
  const lLo = host.querySelector<HTMLElement>('[data-l="lo"]')!;
  const lHi = host.querySelector<HTMLElement>('[data-l="hi"]')!;

  const span = c.max - c.min || 1;
  const fmt = (v: number) => (c.kind === 'date' ? dateShort(v) : compact(v, c.isInt));

  const paint = () => {
    const a = ((f.lo! - c.min) / span) * 100;
    const b = ((f.hi! - c.min) / span) * 100;
    hLo.style.left = a + '%';
    hHi.style.left = b + '%';
    fill.style.left = a + '%';
    fill.style.width = Math.max(0, b - a) + '%';
    lLo.textContent = fmt(f.lo!);
    lHi.textContent = fmt(f.hi!);
    const sum = host.parentElement?.querySelector('.fchip-sum');
    if (sum) sum.textContent = summary(f, c);
  };
  paint();

  let drag: 'lo' | 'hi' | null = null;
  const pick = (e: PointerEvent) => {
    const r = wrap.getBoundingClientRect();
    return c.min + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * span;
  };
  const move = (e: PointerEvent) => {
    if (!drag) return;
    const v = pick(e);
    if (drag === 'lo') f.lo = Math.min(v, f.hi!);
    else f.hi = Math.max(v, f.lo!);
    paint();
    store.setFilter(f);
  };
  const start = (which: 'lo' | 'hi') => (e: PointerEvent) => {
    drag = which;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  on(hLo, 'pointerdown', start('lo'));
  on(hHi, 'pointerdown', start('hi'));
  on(hLo, 'pointermove', move);
  on(hHi, 'pointermove', move);
  const end = () => { drag = null; };
  on(hLo, 'pointerup', end);
  on(hHi, 'pointerup', end);
  on(wrap, 'dblclick', () => { f.lo = c.min; f.hi = c.max; paint(); store.setFilter(f); });
}

/** Categorical / boolean multi-select with live counts. */
function buildChecklist(host: HTMLElement, f: Filter, c: Column) {
  const counts = valueCounts(f.col);
  const total = Math.max(1, counts.reduce((a, b) => a + b, 0));
  const entries =
    c.kind === 'bool'
      ? [{ code: 1, label: 'true' }, { code: 0, label: 'false' }, { code: 2, label: '∅ null' }]
      : (c.dict ?? []).map((label, code) => ({ code, label }));
  const ranked = entries
    .map((e) => ({ ...e, n: counts[e.code] ?? 0 }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 300);

  const sel = new Set(f.set ?? []);
  host.innerHTML = `
    <div style="display:flex;gap:5px;margin-bottom:4px">
      <button class="mini" style="width:auto;padding:0 6px" data-all>all</button>
      <button class="mini" style="width:auto;padding:0 6px" data-none>none</button>
      <button class="mini" style="width:auto;padding:0 6px" data-inv>invert</button>
    </div>
    <div class="cl">
      ${ranked.map((e) => `
        <div class="cl-row" data-c="${e.code}">
          <div class="cbx ${sel.has(e.code) ? 'on' : ''}"></div>
          <span class="cl-name" title="${esc(e.label)}">${esc(e.label)}</span>
          <span class="cl-bar"><i style="width:${((e.n / total) * 100).toFixed(1)}%"></i></span>
          <span class="cl-n">${compact(e.n, true)}</span>
        </div>`).join('')}
    </div>`;

  const commit = () => {
    f.set = [...sel];
    const sum = host.parentElement?.querySelector('.fchip-sum');
    if (sum) sum.textContent = summary(f, c);
    store.setFilter(f);
  };

  on(host, 'click', (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-all]')) { for (const r of ranked) sel.add(r.code); }
    else if (t.closest('[data-none]')) { sel.clear(); }
    else if (t.closest('[data-inv]')) {
      for (const r of ranked) { if (sel.has(r.code)) sel.delete(r.code); else sel.add(r.code); }
    } else {
      const row = t.closest<HTMLElement>('[data-c]');
      if (!row) return;
      const code = +row.dataset.c!;
      if (sel.has(code)) sel.delete(code);
      else sel.add(code);
      row.querySelector('.cbx')!.classList.toggle('on', sel.has(code));
      commit();
      return;
    }
    for (const row of Array.from(host.querySelectorAll<HTMLElement>('[data-c]'))) {
      row.querySelector('.cbx')!.classList.toggle('on', sel.has(+row.dataset.c!));
    }
    commit();
  });
}

/** Value counts over the *unfiltered* column (cheap: single pass, main thread). */
function valueCounts(col: number): number[] {
  const t = S().table;
  const c = t?.cols[col];
  if (!t || !c) return [];
  const n = c.kind === 'bool' ? 3 : c.cardinality;
  const out = new Array(n).fill(0);
  const d = c.data;
  const stride = t.nrows > 400000 ? Math.ceil(t.nrows / 400000) : 1;
  for (let i = 0; i < t.nrows; i += stride) {
    const v = d[i];
    if (v === NULL_CODE) continue;
    if (v < n) out[v] += stride;
  }
  return out;
}

$('#clearF').onclick = () => { store.clearFilters(); renderFilters(); };

// ------------------------------------------------------------------ views
const tabs = $('#tabs');
on(tabs, 'click', (e: MouseEvent) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.tab');
  if (b) setView(b.dataset.v as View);
});

function setView(v: View) {
  store.patch({ view: v }, false);
  for (const t of Array.from(tabs.querySelectorAll('.tab'))) {
    t.classList.toggle('on', (t as HTMLElement).dataset.v === v);
  }
  for (const s of Array.from(document.querySelectorAll('.view'))) {
    s.classList.toggle('on', s.id === `v-${v}`);
  }
  syncControls();
  // Group-by requirements differ per view, so re-run the query.
  applyViewGrouping();
  resizeAll();
  dirty = true;
}

/**
 * Each view needs a different grouping. Rather than run several queries, the
 * spec is rewritten to match the active view and a single query is issued.
 */
function applyViewGrouping() {
  const s = S();
  if (s.view === 'bars') store.patch({ groupCol: +$<HTMLSelectElement>('#barGroup').value }, true);
  else if (s.view === 'trend') store.patch({ groupCol: +$<HTMLSelectElement>('#trGroup').value }, true);
  else if (s.view === 'matrix') store.patch({ groupCol: s.matrixA }, true);
  else store.query();
}

function syncControls() {
  const s = S();
  if (!s.table) return;
  const groupable = (c: Column) => c.kind !== 'bool' || true;
  optionsFor($<HTMLSelectElement>('#barGroup'), groupable, s.groupCol >= 0 ? s.groupCol : 0);
  optionsFor($<HTMLSelectElement>('#barCol'), (c) => c.kind === 'num', s.metricCol);
  aggOptions($<HTMLSelectElement>('#barFn'), s.metricFn);

  optionsFor($<HTMLSelectElement>('#trGroup'), (c) => c.kind === 'date' || c.kind === 'num', s.trendCol);
  optionsFor($<HTMLSelectElement>('#trCol'), (c) => c.kind === 'num', s.metricCol);
  aggOptions($<HTMLSelectElement>('#trFn'), s.metricFn);

  optionsFor($<HTMLSelectElement>('#scX'), (c) => isNum(c), s.scatterX);
  optionsFor($<HTMLSelectElement>('#scY'), (c) => isNum(c), s.scatterY);
  optionsFor($<HTMLSelectElement>('#scC'), (c) => c.kind === 'cat' || c.kind === 'bool', s.scatterC, true);

  optionsFor($<HTMLSelectElement>('#mxA'), (c) => c.kind === 'cat' || c.kind === 'bool' || c.kind === 'date' || c.kind === 'num', s.matrixA);
  optionsFor($<HTMLSelectElement>('#mxB'), (c) => c.kind === 'cat' || c.kind === 'bool', s.matrixB);
  optionsFor($<HTMLSelectElement>('#mxCol'), (c) => c.kind === 'num', s.metricCol);
  aggOptions($<HTMLSelectElement>('#mxFn'), s.metricFn);
}

// control wiring
$<HTMLSelectElement>('#barGroup').onchange = (e) =>
  store.patch({ groupCol: +(e.target as HTMLSelectElement).value });
$<HTMLSelectElement>('#barCol').onchange = (e) => {
  const v = +(e.target as HTMLSelectElement).value;
  store.patch({ metricCol: v, histCol: v });
  syncControls();
};
$<HTMLSelectElement>('#barFn').onchange = (e) => {
  store.patch({ metricFn: (e.target as HTMLSelectElement).value as AggFn });
  syncControls();
};
let barSortMode: 'value' | 'label' = 'value';
on($('#barSort'), 'click', (e: MouseEvent) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button');
  if (!b) return;
  barSortMode = b.dataset.s as 'value' | 'label';
  for (const x of Array.from($('#barSort').querySelectorAll('button'))) x.classList.toggle('on', x === b);
  dirty = true;
});

$<HTMLSelectElement>('#trGroup').onchange = (e) => {
  const v = +(e.target as HTMLSelectElement).value;
  store.patch({ trendCol: v, groupCol: v });
};
$<HTMLSelectElement>('#trCol').onchange = (e) => {
  const v = +(e.target as HTMLSelectElement).value;
  store.patch({ metricCol: v, histCol: v });
  syncControls();
};
$<HTMLSelectElement>('#trFn').onchange = (e) => {
  store.patch({ metricFn: (e.target as HTMLSelectElement).value as AggFn });
  syncControls();
};
const trBins = $<HTMLInputElement>('#trBins');
on(trBins, 'input', () => {
  $('#trBinsN').textContent = trBins.value;
  store.patch({ groupBins: +trBins.value });
});

$<HTMLSelectElement>('#scX').onchange = (e) => {
  const v = +(e.target as HTMLSelectElement).value;
  store.patch({ scatterX: v }, false);
  setLog('x', autoLog(cols()[v]));
  scatter.pan = [0, 0];
  scatter.zoom = 1;
  rebuildScatter();
};
$<HTMLSelectElement>('#scY').onchange = (e) => {
  const v = +(e.target as HTMLSelectElement).value;
  store.patch({ scatterY: v }, false);
  setLog('y', autoLog(cols()[v]));
  scatter.pan = [0, 0];
  scatter.zoom = 1;
  rebuildScatter();
};

function setLog(axis: 'x' | 'y', on: boolean) {
  if (axis === 'x') { logX = on; $('#scLogX').classList.toggle('on', on); }
  else { logY = on; $('#scLogY').classList.toggle('on', on); }
}
$<HTMLSelectElement>('#scC').onchange = (e) => { store.patch({ scatterC: +(e.target as HTMLSelectElement).value }, false); rebuildScatter(); };
on($('#scSize'), 'input', (e) => { scatter.pointSize = +(e.target as HTMLInputElement).value; dirty = true; });
on($('#scAlpha'), 'input', (e) => { scatter.opacity = +(e.target as HTMLInputElement).value / 100; dirty = true; });
$('#scReset').onclick = () => { scatter.pan = [0, 0]; scatter.zoom = 1; dirty = true; };
$('#scLogX').onclick = () => {
  logX = !logX;
  $('#scLogX').classList.toggle('on', logX);
  scatter.pan = [0, 0];
  scatter.zoom = 1;
  rebuildScatter();
};
$('#scLogY').onclick = () => {
  logY = !logY;
  $('#scLogY').classList.toggle('on', logY);
  scatter.pan = [0, 0];
  scatter.zoom = 1;
  rebuildScatter();
};

$<HTMLSelectElement>('#mxA').onchange = (e) => store.patch({ matrixA: +(e.target as HTMLSelectElement).value, groupCol: +(e.target as HTMLSelectElement).value });
$<HTMLSelectElement>('#mxB').onchange = (e) => { store.patch({ matrixB: +(e.target as HTMLSelectElement).value }, false); rebuildMatrix(); dirty = true; };
$<HTMLSelectElement>('#mxCol').onchange = (e) => { store.patch({ metricCol: +(e.target as HTMLSelectElement).value }); syncControls(); };
$<HTMLSelectElement>('#mxFn').onchange = (e) => { store.patch({ metricFn: (e.target as HTMLSelectElement).value as AggFn }); syncControls(); };

// ------------------------------------------------------------------ scatter data
let scatterBuf = new Float32Array(0);
let scatterN = 0;
let logX = false;
let logY = false;
const cScatterAx = $<HTMLCanvasElement>('#cScatterAx');

/**
 * Heavy-tailed columns (revenue, latency, …) collapse into a corner on a linear
 * axis. Sample the column and switch to log when the tail is long enough to
 * matter. Explicit user toggles always win.
 */
function autoLog(c: Column | undefined): boolean {
  if (!c || c.kind !== 'num' || c.min <= 0) return false;
  const d = c.data as Float64Array;
  const n = d.length;
  const stride = Math.max(1, Math.floor(n / 20000));
  const s: number[] = [];
  for (let i = 0; i < n; i += stride) {
    const v = d[i];
    if (!Number.isNaN(v)) s.push(v);
  }
  if (s.length < 50) return false;
  s.sort((a, b) => a - b);
  const p50 = s[(s.length * 0.5) | 0];
  const p99 = s[(s.length * 0.99) | 0];
  return p50 > 0 && p99 / p50 > 12;
}

/** Log transform that tolerates zero/negatives by shifting into positive space. */
function makeScale(c: Column, useLog: boolean) {
  const shift = useLog && c.min <= 0 ? 1 - c.min : 0;
  const fwd = useLog ? (v: number) => Math.log10(v + shift) : (v: number) => v;
  const inv = useLog ? (v: number) => Math.pow(10, v) - shift : (v: number) => v;
  return { fwd, inv, useLog };
}

function rebuildScatter() {
  const s = S();
  const t = s.table;
  const r = s.result;
  if (!t || !r) return;
  const cx = t.cols[s.scatterX];
  const cy = t.cols[s.scatterY];
  if (!cx || !cy) return;
  const cc = s.scatterC >= 0 ? t.cols[s.scatterC] : null;

  const sx = makeScale(cx, logX);
  const sy = makeScale(cy, logY);

  const n = r.matched;
  if (scatterBuf.length < n * 3) scatterBuf = new Float32Array(n * 3);
  const dx = cx.data as Float64Array;
  const dy = cy.data as Float64Array;
  const dc = cc?.data;

  let k = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const row = r.index[i];
    const rx = dx[row];
    const ry = dy[row];
    if (Number.isNaN(rx) || Number.isNaN(ry)) continue;
    const x = sx.fwd(rx);
    const y = sy.fwd(ry);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    scatterBuf[k * 3] = x;
    scatterBuf[k * 3 + 1] = y;
    scatterBuf[k * 3 + 2] = dc ? (dc[row] === NULL_CODE ? 0 : dc[row]) : 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    k++;
  }
  scatterN = k;
  if (k === 0) { scatter.upload(scatterBuf, 0, [0, 0, 1, 1]); dirty = true; return; }
  const px = (maxX - minX) * 0.04 || 1;
  const py = (maxY - minY) * 0.04 || 1;
  scatter.upload(scatterBuf, k, [minX - px, minY - py, (maxX - minX) + px * 2 || 1, (maxY - minY) + py * 2 || 1]);
  $('#scNote').textContent = `${int(k)} pts · ${scatter.ok ? 'WebGL2' : 'canvas'} · drag to pan, scroll to zoom`;
  dirty = true;
}

/**
 * Axis/legend overlay for the scatter. Drawn on a separate 2D canvas above the
 * GL surface so pan/zoom stays a pure GPU operation.
 */
function drawScatterAxes() {
  const s = S();
  const t = s.table;
  if (!t) return;
  const cx = t.cols[s.scatterX];
  const cy = t.cols[s.scatterY];
  if (!cx || !cy) return;

  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = cScatterAx.clientWidth;
  const h = cScatterAx.clientHeight;
  if (cScatterAx.width !== Math.round(w * dpr)) {
    cScatterAx.width = Math.round(w * dpr);
    cScatterAx.height = Math.round(h * dpr);
  }
  const c = ctx2d(cScatterAx);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  if (scatterN === 0) {
    c.fillStyle = '#39435a';
    c.font = '12px Inter, system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText('No points for the current selection', w / 2, h / 2);
    c.textAlign = 'left';
    return;
  }

  const sx = makeScale(cx, logX);
  const sy = makeScale(cy, logY);
  const [x0, y0] = scatter.unproject(0, h, w, h);
  const [x1, y1] = scatter.unproject(w, 0, w, h);

  c.font = '10px ui-monospace, monospace';
  c.lineWidth = 1;
  c.strokeStyle = 'rgba(30,37,52,.85)';
  c.fillStyle = '#5d6a80';

  // x ticks
  c.textAlign = 'center';
  c.textBaseline = 'top';
  for (const tv of ticks(x0, x1, 7)) {
    const [px] = scatter.project(tv, 0, w, h);
    if (px < 26 || px > w - 6) continue;
    c.beginPath();
    c.moveTo(px + 0.5, 0);
    c.lineTo(px + 0.5, h - 16);
    c.stroke();
    const real = sx.inv(tv);
    c.fillText(cx.kind === 'date' ? dateShort(real) : compact(real, cx.isInt && !logX), px, h - 13);
  }
  // y ticks
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  for (const tv of ticks(y0, y1, 6)) {
    const [, py] = scatter.project(0, tv, w, h);
    if (py < 8 || py > h - 20) continue;
    c.beginPath();
    c.moveTo(0, py + 0.5);
    c.lineTo(w, py + 0.5);
    c.stroke();
    const real = sy.inv(tv);
    c.fillStyle = '#0a0d14';
    const label = cy.kind === 'date' ? dateShort(real) : compact(real, cy.isInt && !logY);
    const tw = c.measureText(label).width;
    c.fillRect(2, py - 6, tw + 6, 12);
    c.fillStyle = '#5d6a80';
    c.fillText(label, 5, py);
  }

  // axis titles
  c.fillStyle = '#97a3b8';
  c.font = '600 10.5px Inter, system-ui, sans-serif';
  c.textAlign = 'right';
  c.textBaseline = 'bottom';
  c.fillText(`${cx.name}${logX ? ' (log)' : ''} →`, w - 6, h - 2);
  c.save();
  c.translate(11, 8);
  c.textAlign = 'left';
  c.textBaseline = 'top';
  c.fillText(`↑ ${cy.name}${logY ? ' (log)' : ''}`, 0, 0);
  c.restore();

  // colour legend
  const cc = s.scatterC >= 0 ? t.cols[s.scatterC] : null;
  if (cc && (cc.kind === 'cat' || cc.kind === 'bool')) {
    const entries = cc.kind === 'bool'
      ? ['false', 'true']
      : (cc.dict ?? []).slice(0, 12);
    const lx = w - 8;
    let ly = 10;
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    c.font = '10px Inter, system-ui, sans-serif';
    for (let i = 0; i < entries.length; i++) {
      const label = entries[i];
      const tw = c.measureText(label).width;
      c.fillStyle = 'rgba(10,13,20,.72)';
      c.fillRect(lx - tw - 16, ly - 6, tw + 18, 13);
      c.fillStyle = '#c2ccdd';
      c.fillText(label, lx - 11, ly);
      c.fillStyle = color(i);
      c.beginPath();
      c.arc(lx - 5, ly, 3.2, 0, Math.PI * 2);
      c.fill();
      ly += 15;
    }
    if ((cc.dict?.length ?? 0) > 12) {
      c.fillStyle = '#5d6a80';
      c.fillText(`+${cc.dict!.length - 12} more`, lx - 11, ly);
    }
  }
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
}

// scatter interaction: wheel zoom + drag pan
let panning = false;
let panStart: [number, number] = [0, 0];
let panOrigin: [number, number] = [0, 0];
on(cScatter, 'wheel', (e: WheelEvent) => {
  e.preventDefault();
  const r = cScatter.getBoundingClientRect();
  const mx = ((e.clientX - r.left) / r.width) * 2 - 1;
  const my = (1 - (e.clientY - r.top) / r.height) * 2 - 1;
  const f = Math.exp(-e.deltaY * 0.0016);
  const nz = Math.max(0.25, Math.min(400, scatter.zoom * f));
  const k = nz / scatter.zoom;
  scatter.pan[0] = mx - (mx - scatter.pan[0]) * k;
  scatter.pan[1] = my - (my - scatter.pan[1]) * k;
  scatter.zoom = nz;
  dirty = true;
}, { passive: false });
on(cScatter, 'pointerdown', (e: PointerEvent) => {
  panning = true;
  panStart = [e.clientX, e.clientY];
  panOrigin = [...scatter.pan] as [number, number];
  cScatter.setPointerCapture(e.pointerId);
  cScatter.style.cursor = 'grabbing';
});
on(cScatter, 'pointermove', (e: PointerEvent) => {
  if (!panning) return;
  const r = cScatter.getBoundingClientRect();
  scatter.pan[0] = panOrigin[0] + ((e.clientX - panStart[0]) / r.width) * 2;
  scatter.pan[1] = panOrigin[1] - ((e.clientY - panStart[1]) / r.height) * 2;
  dirty = true;
});
on(cScatter, 'pointerup', (e: PointerEvent) => {
  panning = false;
  cScatter.releasePointerCapture(e.pointerId);
  cScatter.style.cursor = 'crosshair';
});
cScatter.style.cursor = 'crosshair';

// ------------------------------------------------------------------ matrix data
let matrix = new Float64Array(0);
let matRows: string[] = [];
let matCols: string[] = [];

/**
 * The worker groups by rows; the column split is computed here over the result
 * index. One pass, dense integer keys, no hashing.
 */
function rebuildMatrix() {
  const s = S();
  const t = s.table;
  const r = s.result;
  if (!t || !r || !r.groups) return;
  const ca = t.cols[s.matrixA];
  const cb = t.cols[s.matrixB];
  if (!ca || !cb) return;

  const R = r.groups.labels.length;
  const Cn = cb.kind === 'bool' ? 3 : Math.min(cb.cardinality, 40);
  matRows = r.groups.labels;
  matCols = cb.kind === 'bool'
    ? ['false', 'true', '∅']
    : (cb.dict ?? []).slice(0, Cn);

  // map row group key -> dense row slot
  const keyToRow = new Map<number, number>();
  for (let i = 0; i < R; i++) keyToRow.set(r.groups.keys[i], i);

  const isBinned = ca.kind === 'num' || ca.kind === 'date';
  const lo = ca.min;
  const hi = ca.max > ca.min ? ca.max : ca.min + 1;
  const nb = s.groupBins;
  const w = (hi - lo) / nb;

  const sum = new Float64Array(R * Cn);
  const cnt = new Float64Array(R * Cn);
  const da = ca.data;
  const db = cb.data;
  const metric = s.metricCol >= 0 ? (t.cols[s.metricCol].data as Float64Array) : null;

  for (let i = 0; i < r.matched; i++) {
    const row = r.index[i];
    let rk: number;
    if (isBinned) {
      const v = (da as Float64Array)[row];
      if (Number.isNaN(v)) continue;
      let b = ((v - lo) / w) | 0;
      if (b < 0) b = 0;
      if (b >= nb) b = nb - 1;
      rk = lo + b * w;
    } else {
      rk = da[row];
      if (rk === NULL_CODE) continue;
    }
    const ri = keyToRow.get(rk);
    if (ri === undefined) continue;
    const bv = db[row];
    const ci = cb.kind === 'bool' ? (bv === 2 ? 2 : bv) : bv;
    if (ci === NULL_CODE || ci >= Cn) continue;
    const o = ri * Cn + ci;
    cnt[o]++;
    if (metric) {
      const mv = metric[row];
      if (!Number.isNaN(mv)) sum[o] += mv;
    }
  }

  matrix = new Float64Array(R * Cn);
  const fn = s.metricFn;
  for (let i = 0; i < R * Cn; i++) {
    if (cnt[i] === 0) { matrix[i] = NaN; continue; }
    matrix[i] = !metric || fn === 'count' ? cnt[i] : fn === 'avg' ? sum[i] / cnt[i] : sum[i];
  }
  $('#mxNote').textContent = `${R} × ${Cn} cells`;
}

// ------------------------------------------------------------------ chart hover
let hoverBar = -1;
let hoverTrend = -1;
let hoverMatrix = -1;
let barHits: C.ChartHit[] = [];
let trendHits: C.ChartHit[] = [];
let matrixHits: C.ChartHit[] = [];

function bindHover(
  cv: HTMLCanvasElement,
  getHits: () => C.ChartHit[],
  set: (i: number) => void,
  mode: 'x' | 'xy',
  fmt: (h: C.ChartHit) => [string, [string, string][]],
) {
  on(cv, 'mousemove', (e: MouseEvent) => {
    const r = cv.getBoundingClientRect();
    const hits = getHits();
    if (!hits.length) return;
    const i = C.nearest(hits, e.clientX - r.left, e.clientY - r.top, mode);
    set(i);
    dirty = true;
    if (i >= 0) {
      const [title, rows] = fmt(hits[i]);
      showTip(e.clientX, e.clientY, title, rows);
    }
  });
  on(cv, 'mouseleave', () => { set(-1); hideTip(); dirty = true; });
}

bindHover(cBars, () => barHits, (i) => (hoverBar = i), 'x', (h) => [
  h.label,
  [[`${S().metricFn} ${colName(S().metricCol)}`, compact(h.value)],
   ['rows', int(groupCountAt(h.i))]],
]);
bindHover(cTrend, () => trendHits, (i) => (hoverTrend = i), 'x', (h) => [
  h.label,
  [[`${S().metricFn} ${colName(S().metricCol)}`, compact(h.value)],
   ['rows', int(groupCountAt(h.i))]],
]);
bindHover(cMatrix, () => matrixHits, (i) => (hoverMatrix = i), 'xy', (h) => [
  h.label,
  [[`${S().metricFn}`, Number.isNaN(h.value) ? 'no data' : compact(h.value)]],
]);

function groupCountAt(i: number): number {
  const g = S().result?.groups;
  if (!g) return 0;
  // bars may be re-sorted for display; map back through the display order
  const src = barOrder.length === g.labels.length ? barOrder[i] ?? i : i;
  return g.count[src] ?? 0;
}

// click a bar to filter by that group
on(cBars, 'click', () => {
  const g = S().result?.groups;
  if (!g || hoverBar < 0 || hoverBar >= g.labels.length) return;
  const src = barOrder[hoverBar] ?? hoverBar;
  const gc = S().groupCol;
  const c = cols()[gc];
  if (!c) return;
  if (c.kind === 'cat' || c.kind === 'bool') {
    const code = g.keys[src];
    const id = `f${gc}_bar`;
    const existing = S().filters.find((f) => f.col === gc && f.op === 'in');
    if (existing) {
      const set = new Set(existing.set ?? []);
      if (set.has(code)) set.delete(code);
      else set.add(code);
      existing.set = [...set];
      store.setFilter(existing);
    } else {
      store.setFilter({ id, col: gc, op: 'in', set: [code], enabled: true });
    }
    renderFilters();
    toast(`Filtered ${c.name} → ${g.labels[src]}`, 'ok');
  }
});

// ------------------------------------------------------------------ right panel
function renderInsights() {
  const s = S();
  const t = s.table;
  const r = s.result;
  const sg = $('#statGrid');
  if (!t || !r) { sg.innerHTML = ''; return; }

  const pct = (r.matched / t.nrows) * 100;
  const mc = s.metricCol >= 0 ? t.cols[s.metricCol] : null;

  // Aggregate the focused metric over the current selection.
  let sum = 0;
  let n = 0;
  let mn = Infinity;
  let mx = -Infinity;
  if (mc && mc.kind === 'num') {
    const d = mc.data as Float64Array;
    for (let i = 0; i < r.matched; i++) {
      const v = d[r.index[i]];
      if (Number.isNaN(v)) continue;
      sum += v;
      n++;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  const avg = n ? sum / n : NaN;

  sg.innerHTML = `
    <div class="sc"><div class="sc-l">Rows in view</div><div class="sc-v acc">${int(r.matched)}</div>
      <div class="sc-d ${pct >= 99.9 ? '' : 'down'}">${pct.toFixed(1)}% of ${int(t.nrows)}</div></div>
    <div class="sc"><div class="sc-l">Query time</div><div class="sc-v">${ms(r.stats.totalMs)}</div>
      <div class="sc-d up">${int(r.matched / Math.max(0.001, r.stats.totalMs) * 1000)} rows/s</div></div>
    ${mc ? `
    <div class="sc wide"><div class="sc-l">${esc(mc.name)} — total</div>
      <div class="sc-v acc">${compact(sum)}</div>
      <div class="sc-d">avg ${compact(avg)} · min ${compact(mn)} · max ${compact(mx)}</div></div>` : ''}
    <div class="sc"><div class="sc-l">Filters</div><div class="sc-v">${s.filters.filter((f) => f.enabled).length}</div>
      <div class="sc-d">${s.filters.length} defined</div></div>
    <div class="sc"><div class="sc-l">Memory</div><div class="sc-v">${bytes(t.bytes)}</div>
      <div class="sc-d">${t.cols.length} cols</div></div>`;

  // distribution
  const hc = s.histCol !== null ? t.cols[s.histCol] : null;
  $('#distName').textContent = hc ? hc.name : '';
  if (r.hist && hc) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = cDist.clientWidth;
    cDist.width = w * dpr;
    cDist.height = 88 * dpr;
    const c = ctx2d(cDist);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    C.histogram(c, w, 88, r.hist.bins, r.hist.lo, r.hist.hi,
      (v) => (hc.kind === 'date' ? dateShort(v) : compact(v, hc.isInt)));
  }

  // top values of the focused categorical (or the group column)
  const fc = t.cols[s.focusCol];
  const catCol = fc && (fc.kind === 'cat' || fc.kind === 'bool') ? s.focusCol : s.groupCol;
  const cc = t.cols[catCol];
  $('#topName').textContent = cc ? cc.name : '';
  const tk = $('#topk');
  if (!cc) { tk.innerHTML = ''; return; }

  const nvals = cc.kind === 'bool' ? 3 : Math.min(cc.cardinality, 4000);
  const counts = new Float64Array(nvals + 1);
  const d = cc.data;
  const isBinned = cc.kind === 'num' || cc.kind === 'date';
  if (isBinned) {
    tk.innerHTML = `<div class="empty" style="padding:10px">Select a categorical field to see its top values.</div>`;
    return;
  }
  for (let i = 0; i < r.matched; i++) {
    const v = d[r.index[i]];
    counts[v === NULL_CODE || v > nvals ? nvals : v]++;
  }
  const ranked = Array.from(counts, (v, i) => ({ v, i }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, 10);
  const top = ranked[0]?.v ?? 1;
  tk.innerHTML = ranked.map((x) => {
    const label = x.i === nvals ? '∅ null' : cc.kind === 'bool' ? (x.i === 1 ? 'true' : 'false') : cc.dict?.[x.i] ?? '?';
    return `<div class="tk-row">
      <span class="tk-name" title="${esc(label)}">${esc(label)}</span>
      <span class="tk-bar"><i style="width:${((x.v / top) * 100).toFixed(1)}%"></i></span>
      <span class="tk-v">${compact(x.v, true)}</span></div>`;
  }).join('');
}

// ------------------------------------------------------------------ render loop
let dirty = true;
let anim = 0;
let animTarget = 1;
let barOrder: number[] = [];
let frameMs = 0;
let fps = 60;
const fpsHist = new Float32Array(54);
let fpsIdx = 0;
let lastT = performance.now();
const fpsC = $<HTMLCanvasElement>('#fpsC');
const fpsCtx = fpsC.getContext('2d')!;

function loop(now: number) {
  const dt = now - lastT;
  lastT = now;
  const inst = 1000 / Math.max(0.5, dt);
  fps += (inst - fps) * 0.08;

  if (anim < animTarget) { anim = Math.min(animTarget, anim + 0.075); dirty = true; }

  const t0 = performance.now();
  if (dirty) {
    dirty = false;
    draw();
  }
  grid.tick();
  frameMs = frameMs * 0.85 + (performance.now() - t0) * 0.15;

  fpsHist[fpsIdx = (fpsIdx + 1) % fpsHist.length] = fps;
  if ((fpsIdx & 7) === 0) paintFps();

  requestAnimationFrame(loop);
}

function paintFps() {
  const w = fpsC.width;
  const h = fpsC.height;
  fpsCtx.clearRect(0, 0, w, h);
  fpsCtx.beginPath();
  for (let i = 0; i < fpsHist.length; i++) {
    const v = fpsHist[(fpsIdx + 1 + i) % fpsHist.length] || 0;
    const y = h - Math.min(1, v / 70) * (h - 3) - 1.5;
    const x = (i / (fpsHist.length - 1)) * w;
    if (i === 0) fpsCtx.moveTo(x, y);
    else fpsCtx.lineTo(x, y);
  }
  fpsCtx.strokeStyle = fps > 50 ? '#37e2a0' : fps > 30 ? '#ffb347' : '#ff5f6d';
  fpsCtx.lineWidth = 1.2;
  fpsCtx.stroke();
  $('#fFps').textContent = String(Math.round(fps));
  $('#fFps').className = fps > 50 ? 'ok' : fps > 30 ? '' : 'down';
  $('#fFrame').textContent = frameMs.toFixed(2) + 'ms';
}

function draw() {
  const s = S();
  const r = s.result;
  if (s.view === 'grid') { grid.invalidate(); return; }
  if (!r) return;

  if (s.view === 'bars') drawBars();
  else if (s.view === 'trend') drawTrend();
  else if (s.view === 'scatter') { fitCanvas(cScatter); scatter.draw(); drawScatterAxes(); }
  else if (s.view === 'matrix') drawMatrix();
}

function fitCanvas(cv: HTMLCanvasElement): [CanvasRenderingContext2D, number, number] {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (cv === cScatter) { scatter.resize(w, h, dpr); return [null as any, w, h]; }
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const c = ctx2d(cv);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [c, w, h];
}

function drawBars() {
  const g = S().result?.groups;
  const [c, w, h] = fitCanvas(cBars);
  C.clear(c, w, h);
  if (!g || !g.labels.length) { emptyChart(c, w, h); barHits = []; return; }

  // With no metric chosen the count is the metric.
  const vals = g.values[0] ?? g.count;
  const order = vals.length ? Array.from(vals, (_, i) => i) : [];
  if (barSortMode === 'value') order.sort((a, b) => (vals[b] || 0) - (vals[a] || 0));
  barOrder = order;

  const sorted = new Float64Array(order.length);
  const labels: string[] = [];
  for (let i = 0; i < order.length; i++) { sorted[i] = vals[order[i]]; labels.push(g.labels[order[i]]); }

  const f = C.frame(w, h);
  barHits = C.bars(c, f, sorted, labels, anim, hoverBar, 'index');
  $('#barNote').textContent =
    `${g.labels.length} groups${g.truncated ? ` · ${g.truncated} more hidden` : ''} · click a bar to filter`;
}

function drawTrend() {
  const g = S().result?.groups;
  const [c, w, h] = fitCanvas(cTrend);
  C.clear(c, w, h);
  if (!g || !g.labels.length) { emptyChart(c, w, h); trendHits = []; return; }
  const vals = g.values[0] ?? g.count;
  const f = C.frame(w, h);
  trendHits = C.line(c, f, vals, g.labels, anim, hoverTrend);
}

function drawMatrix() {
  const [c, w, h] = fitCanvas(cMatrix);
  C.clear(c, w, h);
  if (!matrix.length) { emptyChart(c, w, h); matrixHits = []; return; }
  const f = C.frame(w, h, 104, 40);
  matrixHits = C.heatmap(c, f, matrix, matRows, matCols, hoverMatrix);
}

function emptyChart(c: CanvasRenderingContext2D, w: number, h: number) {
  c.fillStyle = '#39435a';
  c.font = '12px Inter, system-ui, sans-serif';
  c.textAlign = 'center';
  c.fillText('No data for the current selection', w / 2, h / 2);
  c.textAlign = 'left';
}

function resizeAll() {
  grid.resize();
  grid.syncSpacer();
  dirty = true;
}

// ------------------------------------------------------------------ store wiring
store.onProgress((phase, pct) => {
  $('#bootMsg').textContent = phase;
  ($('#bootBar') as HTMLElement).style.width = (pct * 100).toFixed(0) + '%';
});

store.onError((m) => { toast(m, 'err'); hideBoot(); });

store.onTable((t) => {
  // A new table invalidates every cached buffer and hover index.
  scatterBuf = new Float32Array(0);
  scatterN = 0;
  matrix = new Float64Array(0);
  matRows = [];
  matCols = [];
  barHits = trendHits = matrixHits = [];
  hoverBar = hoverTrend = hoverMatrix = -1;
  barOrder = [];
  fieldQuery = '';
  fieldSearch.value = '';

  syncControls();
  // Heavy-tailed measures get a log axis by default so the cloud fills the plot.
  setLog('x', autoLog(t.cols[S().scatterX]));
  setLog('y', autoLog(t.cols[S().scatterY]));
  scatter.pan = [0, 0];
  scatter.zoom = 1;
  renderFields();
  renderFilters();
  grid.layout(t);
  grid.syncSpacer();
  resizeAll();

  // Populate the counters from the table itself so the footer never flashes
  // "0 rows" in the gap between the table landing and the first query result.
  $('#pillRows').innerHTML = `<b>${int(t.nrows)}</b> <span class="dim">/ ${int(t.nrows)} rows</span>`;
  $('#fRows').textContent = int(t.nrows);
  $('#fMem').textContent = bytes(t.bytes);
  $('#fQuery').textContent = '…';

  hideBoot();
  toast(`Loaded ${int(t.nrows)} rows × ${t.cols.length} cols in ${ms(S().loadMs)}`, 'ok');
});

store.on((s, reason) => {
  const pulse = $('#pulse');
  pulse.classList.toggle('busy', s.busy);
  if (reason === 'result' && s.result) {
    const r = s.result;
    $('#pillRows').innerHTML = `<b>${int(r.matched)}</b> <span class="dim">/ ${int(s.table?.nrows ?? 0)} rows</span>`;
    $('#fRows').textContent = int(r.matched);
    $('#fQuery').textContent = ms(r.stats.totalMs);
    $('#fMem').textContent = bytes(s.table?.bytes ?? 0);
    grid.syncSpacer();
    anim = 0;
    animTarget = 1;
    if (s.view === 'scatter') rebuildScatter();
    if (s.view === 'matrix') rebuildMatrix();
    renderInsights();
    dirty = true;
  }
});

/**
 * The overlay is reused for every load (initial synth, CSV import, re-generate),
 * so it is only ever hidden — never removed from the DOM.
 */
function hideBoot() {
  $('#boot').classList.add('gone');
}

function showBoot(msg: string) {
  const b = $('#boot');
  $('#bootMsg').textContent = msg;
  ($('#bootBar') as HTMLElement).style.width = '0%';
  b.classList.remove('gone');
}

// ------------------------------------------------------------------ CSV load
const fileInput = el('input');
fileInput.type = 'file';
fileInput.accept = '.csv,text/csv';
fileInput.style.display = 'none';
document.body.appendChild(fileInput);

on(fileInput, 'change', () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  loadFile(f);
  fileInput.value = '';
});

function loadFile(f: File) {
  showBoot(`reading ${f.name}…`);
  f.arrayBuffer().then((buf) => store.loadCSV(buf, f.name));
}

$('#btnLoad').onclick = () => fileInput.click();

// drag & drop
const drop = $('#drop');
let dragDepth = 0;
on(window, 'dragenter', (e: DragEvent) => { e.preventDefault(); if (++dragDepth === 1) drop.classList.add('on'); });
on(window, 'dragover', (e: DragEvent) => e.preventDefault());
on(window, 'dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('on'); } });
on(window, 'drop', (e: DragEvent) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('on');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// ------------------------------------------------------------------ export
store.onExport((csv, rows) => {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${S().table?.name ?? 'nebula'}_export.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`Exported ${int(rows)} rows`, 'ok');
});
$('#btnExport').onclick = () => {
  if (!S().result) return;
  toast('Preparing export…');
  store.exportCSV();
};

// ------------------------------------------------------------------ generate
$('#btnGen').onclick = () => openGenerate();

function openGenerate() {
  const scrim = el('div', 'scrim');
  scrim.innerHTML = `
    <div class="modal">
      <div class="modal-h">Generate dataset</div>
      <div class="modal-b">
        Builds a correlated commerce + delivery telemetry table in a Web Worker.
        Everything stays in memory as typed arrays.
        <div class="row"><label>Rows</label>
          <input type="range" id="gRows" min="10000" max="2000000" step="10000" value="500000" />
          <input class="num-in" id="gRowsN" value="500,000" readonly /></div>
        <div class="row"><label>Seed</label>
          <input type="range" id="gSeed" min="1" max="999" value="7" />
          <input class="num-in" id="gSeedN" value="7" readonly /></div>
        <div id="gEst" style="font-family:var(--mono);font-size:11px;color:var(--txt-3)"></div>
      </div>
      <div class="modal-f">
        <button class="hbtn" id="gCancel">Cancel</button>
        <button class="hbtn primary" id="gGo">Generate</button>
      </div>
    </div>`;
  document.body.appendChild(scrim);
  const rows = scrim.querySelector<HTMLInputElement>('#gRows')!;
  const seed = scrim.querySelector<HTMLInputElement>('#gSeed')!;
  const est = scrim.querySelector<HTMLElement>('#gEst')!;
  const upd = () => {
    scrim.querySelector<HTMLInputElement>('#gRowsN')!.value = (+rows.value).toLocaleString();
    scrim.querySelector<HTMLInputElement>('#gSeedN')!.value = seed.value;
    est.textContent = `≈ ${bytes(+rows.value * 19 * 6.7)} in memory · 19 columns`;
  };
  upd();
  on(rows, 'input', upd);
  on(seed, 'input', upd);
  const close = () => scrim.remove();
  scrim.querySelector('#gCancel')!.addEventListener('click', close);
  scrim.querySelector('#gGo')!.addEventListener('click', () => {
    close();
    showBoot('generating rows…');
    store.synth(+rows.value, +seed.value);
  });
  on(scrim, 'click', (e: MouseEvent) => { if (e.target === scrim) close(); });
}

// ------------------------------------------------------------------ panels
$('#btnLeft').onclick = () => { app.classList.toggle('no-left'); resizeAll(); };
$('#btnRight').onclick = () => { app.classList.toggle('no-right'); resizeAll(); };
$('#btnClear').onclick = () => { store.clearFilters(); renderFilters(); toast('Filters cleared'); };

// ------------------------------------------------------------------ shortcuts sheet
function openShortcuts() {
  const rows: [string, string][] = [
    ['⌘K / Ctrl+K', 'Command palette'],
    ['1 … 5', 'Table · Breakdown · Trend · Scatter · Matrix'],
    ['/', 'Search fields'],
    ['C', 'Clear all filters'],
    ['F / I', 'Toggle left / right panel'],
    ['E', 'Export current view as CSV'],
    ['G', 'Generate a new dataset'],
    ['?', 'This sheet'],
    ['↑ ↓ PgUp PgDn', 'Move the row cursor (table)'],
    ['Click header', 'Sort · click again to flip · third click clears'],
    ['Drag header edge', 'Resize · double-click to auto-fit'],
    ['Scroll / drag', 'Zoom and pan the scatter plot'],
    ['Click a bar', 'Filter to that group'],
  ];
  const scrim = el('div', 'scrim');
  scrim.innerHTML = `
    <div class="modal">
      <div class="modal-h">Keyboard &amp; pointer</div>
      <div class="modal-b">
        <div style="display:grid;grid-template-columns:auto 1fr;gap:7px 14px;align-items:center">
          ${rows.map(([k, v]) =>
            `<span class="kbd" style="justify-self:start;white-space:nowrap">${esc(k)}</span><span>${esc(v)}</span>`,
          ).join('')}
        </div>
      </div>
      <div class="modal-f"><button class="hbtn primary" id="skClose">Got it</button></div>
    </div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.querySelector('#skClose')!.addEventListener('click', close);
  on(scrim, 'click', (e: MouseEvent) => { if (e.target === scrim) close(); });
}

// ------------------------------------------------------------------ command palette
interface Cmd { id: string; title: string; hint?: string; sec: string; run: () => void; }

function commands(): Cmd[] {
  const out: Cmd[] = [
    { id: 'v.grid', title: 'View: Table', hint: '1', sec: 'Views', run: () => setView('grid') },
    { id: 'v.bars', title: 'View: Breakdown', hint: '2', sec: 'Views', run: () => setView('bars') },
    { id: 'v.trend', title: 'View: Trend', hint: '3', sec: 'Views', run: () => setView('trend') },
    { id: 'v.scatter', title: 'View: Scatter (GPU)', hint: '4', sec: 'Views', run: () => setView('scatter') },
    { id: 'v.matrix', title: 'View: Matrix', hint: '5', sec: 'Views', run: () => setView('matrix') },
    { id: 'a.clear', title: 'Clear all filters', hint: 'C', sec: 'Actions', run: () => { store.clearFilters(); renderFilters(); } },
    { id: 'a.export', title: 'Export current view as CSV', sec: 'Actions', run: () => store.exportCSV() },
    { id: 'a.gen', title: 'Generate a new dataset…', sec: 'Actions', run: openGenerate },
    { id: 'a.load', title: 'Load a CSV file…', sec: 'Actions', run: () => fileInput.click() },
    { id: 'a.left', title: 'Toggle fields panel', hint: 'F', sec: 'Actions', run: () => { app.classList.toggle('no-left'); resizeAll(); } },
    { id: 'a.right', title: 'Toggle insights panel', hint: 'I', sec: 'Actions', run: () => { app.classList.toggle('no-right'); resizeAll(); } },
    { id: 'a.keys', title: 'Keyboard shortcuts', hint: '?', sec: 'Actions', run: openShortcuts },
  ];
  const t = S().table;
  if (t) {
    t.cols.forEach((c, i) => {
      out.push({ id: `f.${i}`, title: `Filter by ${c.name}`, hint: c.kind, sec: 'Filter', run: () => { addFilterFor(i); renderFilters(); } });
      out.push({ id: `s.${i}`, title: `Sort by ${c.name}`, hint: c.kind, sec: 'Sort', run: () => store.setSort(i) });
      if (c.kind === 'cat' || c.kind === 'bool' || c.kind === 'date' || c.kind === 'num') {
        out.push({ id: `g.${i}`, title: `Group by ${c.name}`, hint: c.kind, sec: 'Group', run: () => { store.patch({ groupCol: i }); syncControls(); if (S().view === 'grid') setView('bars'); } });
      }
      if (c.kind === 'num') {
        out.push({ id: `m.${i}`, title: `Metric → ${c.name}`, hint: 'num', sec: 'Metric', run: () => { store.patch({ metricCol: i, histCol: i }); syncControls(); } });
      }
    });
    for (const fn of AGGS) {
      out.push({ id: `af.${fn}`, title: `Aggregate: ${fn}`, sec: 'Metric', run: () => { store.patch({ metricFn: fn }); syncControls(); } });
    }
  }
  return out;
}

let palOpen = false;
function openPalette() {
  if (palOpen) return;
  palOpen = true;
  const all = commands();
  const scrim = el('div', 'scrim');
  scrim.innerHTML = `
    <div class="pal">
      <input class="pal-in" id="palIn" placeholder="Type a command, field, or action…" spellcheck="false" />
      <div class="pal-list" id="palList"></div>
    </div>`;
  document.body.appendChild(scrim);
  const input = scrim.querySelector<HTMLInputElement>('#palIn')!;
  const list = scrim.querySelector<HTMLElement>('#palList')!;
  let sel = 0;
  let shown: Cmd[] = [];

  const render = () => {
    const q = input.value.toLowerCase().trim();
    shown = q
      ? all.map((c) => ({ c, s: score(c.title.toLowerCase(), q) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 40)
          .map((x) => x.c)
      : all.slice(0, 30);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    let html = '';
    let sec = '';
    shown.forEach((c, i) => {
      if (c.sec !== sec) { sec = c.sec; html += `<div class="pal-sec">${esc(sec)}</div>`; }
      html += `<div class="pal-item ${i === sel ? 'on' : ''}" data-i="${i}">
        <span class="pi-i">${i === sel ? '›' : ''}</span>
        <span class="pi-t">${esc(c.title)}</span>
        ${c.hint ? `<span class="pi-d">${esc(c.hint)}</span>` : ''}</div>`;
    });
    list.innerHTML = html || '<div class="empty">No matches</div>';
    list.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' });
  };
  render();
  input.focus();

  const close = () => { palOpen = false; scrim.remove(); };
  on(input, 'input', render);
  on(scrim, 'click', (e: MouseEvent) => {
    if (e.target === scrim) return close();
    const it = (e.target as HTMLElement).closest<HTMLElement>('.pal-item');
    if (it) { shown[+it.dataset.i!]?.run(); close(); }
  });
  on(input, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') { close(); }
    else if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { shown[sel]?.run(); close(); }
  });
}

/** Subsequence fuzzy score with a bonus for prefix + word-boundary hits. */
function score(text: string, q: string): number {
  let ti = 0;
  let s = 0;
  let streak = 0;
  for (const ch of q) {
    const at = text.indexOf(ch, ti);
    if (at < 0) return 0;
    if (at === ti) { streak++; s += 6 + streak * 2; }
    else { streak = 0; s += 2; }
    if (at === 0 || text[at - 1] === ' ' || text[at - 1] === ':') s += 5;
    ti = at + 1;
  }
  return s + Math.max(0, 22 - text.length) * 0.4;
}

$('#btnCmd').onclick = openPalette;

// ------------------------------------------------------------------ shortcuts
on(window, 'keydown', (e: KeyboardEvent) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); fieldSearch.focus(); return; }
  const map: Record<string, View> = { '1': 'grid', '2': 'bars', '3': 'trend', '4': 'scatter', '5': 'matrix' };
  if (map[e.key]) { setView(map[e.key]); return; }
  const k = e.key.toLowerCase();
  if (k === 'c') { store.clearFilters(); renderFilters(); }
  else if (k === 'f') { app.classList.toggle('no-left'); resizeAll(); }
  else if (k === 'i') { app.classList.toggle('no-right'); resizeAll(); }
  else if (k === 'e') store.exportCSV();
  else if (k === 'g') openGenerate();
  else if (e.key === '?') openShortcuts();
});

// ------------------------------------------------------------------ resize
const ro = new ResizeObserver(debounce(() => resizeAll(), 60));
ro.observe(gridwrap);
on(window, 'resize', debounce(() => resizeAll(), 60));

// ------------------------------------------------------------------ first run
/**
 * One-time orientation hint. Persisted so it never nags on repeat visits, and
 * dismissed by any interaction rather than requiring a click on a target.
 */
function maybeHint() {
  try {
    if (localStorage.getItem('nebula.seen') === '1') return;
    localStorage.setItem('nebula.seen', '1');
  } catch { /* private mode — just show it */ }
  setTimeout(() => {
    toast('Press ⌘K for commands · 1–5 switch views · drag a field\'s funnel to filter');
  }, 1200);
}
maybeHint();

// ------------------------------------------------------------------ test hook
// Small surface used by the headless verification suite to drive the app
// without depending on canvas pixel coordinates.
(window as unknown as Record<string, unknown>).__nebula = {
  cols: () => cols().map((c) => ({ name: c.name, kind: c.kind })),
  sort: (i: number) => store.setSort(i),
  view: setView,
  filters: () => S().filters,
  stats: () => S().result?.stats,
  matched: () => S().result?.matched ?? 0,
};

// ------------------------------------------------------------------ go
$('#trBinsN').textContent = trBins.value;
requestAnimationFrame(loop);
store.synth(500000, 7);
