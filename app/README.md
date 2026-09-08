<h1 align="center">Nebula</h1>

<p align="center"><i>An in-browser data studio. A million rows, filtered, grouped and rendered at 60fps — with no backend at all.</i></p>

<p align="center">
<img src="https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white">
<img src="https://img.shields.io/badge/WebGL2-990000?style=flat-square&logo=webgl&logoColor=white">
<img src="https://img.shields.io/badge/Web%20Workers-5A29E4?style=flat-square">
<img src="https://img.shields.io/badge/dependencies-0-2ea44f?style=flat-square">
<img src="https://img.shields.io/badge/bundle-101%20KB-1c1c1c?style=flat-square">
</p>

---

Drop in a CSV — or generate a synthetic one — and explore it. Everything runs
locally: the file never leaves the tab, there is no server, and there are no
runtime dependencies.

```bash
cd app
npm install
npm run dev      # http://localhost:5173
```

```bash
npm test         # 29 correctness tests
npm run bench    # stage-level timings at 1M rows
npm run build    # typecheck + production bundle
```

---

## Why it's fast

The whole design follows from one decision: **the data is never an array of
objects.** It is a set of typed arrays, one per column, and the UI thread never
iterates it.

**Columnar storage.** Each column is a single contiguous buffer — `Float64Array`
for numbers and dates, `Uint8Array` for booleans, and dictionary-encoded
`Uint32Array` for strings. A 1M-row, 19-column table is ~101 MB with no
per-row object headers, no pointer chasing, and no GC pressure. Scanning one
column touches only that column's memory.

**The engine lives in a Web Worker.** It owns the data; the main thread only
ever receives a result index and a handful of aggregate arrays. Filtering a
million rows cannot jank a scroll, because it does not happen on the thread
doing the scrolling.

**Coalesced queries.** While a query is in flight, new requests collapse into a
single pending slot instead of queueing. Dragging a range slider fires dozens of
updates and the worker still only runs the latest one — results that arrive out
of order are dropped by version number.

**Radix sort instead of a comparator.** Doubles are re-encoded so that unsigned
integer ordering matches float ordering, then sorted with a 4-pass 16-bit LSD
radix sort. Digit extraction is inlined per pass, keys travel alongside the
payload so reads stay sequential, and a pass whose digit never varies is
skipped. That's **~11x faster than `Array#sort`** at 1M rows.

**Dense group keys.** Categorical group-bys index by dictionary code and numeric
ones by linear bin, so a group id is always an integer — accumulation is a flat
typed-array write with no hashing. Group ids are materialised once into a
`Uint32Array`, which keeps the closure call out of the innermost loop and lets
the median pass reuse them.

**Canvas, not DOM.** The grid is one `<canvas>` and one empty scroll spacer. Ten
rows and ten million rows produce identical DOM. Painting is culled to the
visible window on both axes and skipped entirely when nothing changed.

**The GPU draws the scatter plot.** Points are packed into one interleaved
`Float32Array` and uploaded once per query; pan and zoom afterwards are a
uniform update and a single `drawArrays` call. A million points stay at 60fps.
Without WebGL2 it falls back to a decimated canvas path.

---

## Measured

1M synthetic rows × 19 columns, best of 5, Node 22 on the sandbox CPU
(`npm run bench`):

| stage | time |
|---|---|
| full scan, no filter | **3.0 ms** |
| range filter | **12.2 ms** |
| three stacked filters | **23.7 ms** |
| sort by revenue (1M doubles) | **55 ms** |
| sort by category | **18 ms** |
| group by region + sum | **15.5 ms** |
| group into 48 date bins | **17.3 ms** |
| group + median (worst case) | **56 ms** |
| 64-bin histogram | **6.7 ms** |
| **filter + sort + group + histogram** | **117 ms** |

In the browser the grid holds 60fps while scrolling 1M rows, with a frame cost
under 1 ms. `Array#sort` with a comparator on the same 1M doubles: 571 ms.

---

## What you can do

**Five views.** A virtualized table; a breakdown bar chart; a binned trend line;
a GPU scatter plot; and a two-dimensional heatmap matrix.

**Filters that compose.** Dual-handle range sliders with the column's
distribution drawn behind them, and categorical checklists with live counts and
proportion bars. Filters stack as AND, and each can be toggled off without
losing its configuration. New filters start as no-ops so adding one never blanks
the view.

**It reads the data.** Field types are inferred on import — dates, booleans,
numbers, and dictionary-encoded strings, with nulls tracked per column. Default
axes skip ID-like columns, the matrix avoids nesting `country` inside `region`,
and heavy-tailed measures like revenue get a log axis automatically so the cloud
fills the plot instead of hugging a corner.

**Command palette.** `⌘K` fuzzy-matches every view, field, filter, sort, group
and aggregate in the loaded table. Press `?` for the full shortcut sheet.

**Real CSV parsing.** Byte-level single pass straight from the `ArrayBuffer` —
RFC-4180 quoting, embedded newlines and commas, CRLF, BOM, ragged rows, and
thousands separators, with no intermediate string array.

---

## Layout

```
app/
├── src/
│   ├── worker/
│   │   ├── main.ts      worker entry — owns the columnar store
│   │   ├── engine.ts    filter → sort → group → histogram
│   │   ├── sort.ts      radix + counting sorts, quickselect
│   │   ├── csv.ts       byte-level CSV → typed arrays
│   │   └── synth.ts     correlated synthetic dataset
│   ├── ui/
│   │   ├── grid.ts      virtualized canvas table
│   │   ├── scatter.ts   WebGL2 point renderer
│   │   ├── charts.ts    bars, lines, histogram, heatmap
│   │   └── dom.ts       small DOM helpers
│   ├── state.ts         coalesced query dispatch
│   ├── types.ts         main-thread ↔ worker contracts
│   ├── fmt.ts           formatting + palette
│   └── main.ts          shell, panels, render loop
└── test/
    ├── engine.test.mjs  sorting and selection
    ├── query.test.mjs   filters and aggregates vs. references
    └── bench.mjs        stage-level timings
```

Tests run the real TypeScript sources directly under Node 22's native type
stripping — no build step, no test framework. Aggregates are checked against
naive reference implementations computed independently in the test file, so an
optimisation that changes a result fails the suite.

---

## Notes

The generated dataset has structure baked into it — channel drives revenue,
region drives margin, device drives the latency tail, low ratings drive returns,
and there's a seasonal swell with a weekend dip. Slicing it reveals real
patterns rather than uniform noise, which makes it useful for judging whether a
view actually communicates something.

Built with vanilla TypeScript and Vite. No framework, no chart library, no state
manager.
