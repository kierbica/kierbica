/**
 * Index sorts specialised per column kind.
 *
 * Floats use a 4-pass, 16-bit LSD radix sort over a monotonic uint64
 * re-encoding of the IEEE-754 bits. Three details make it fast:
 *
 *   1. Digit extraction is inlined per pass — no comparator, no closure call
 *      in the inner loop (that alone was ~2x).
 *   2. Keys are permuted alongside the payload so every read is sequential;
 *      only the scatter write is random.
 *   3. A pass whose digit is constant across the whole column is skipped, which
 *      is the common case for the high word of real-world numeric data.
 *
 * Dictionary codes and booleans use counting sort — a single pass.
 */

const RADIX = 1 << 16;
const MASK = RADIX - 1;
const counts = new Uint32Array(RADIX);

// Double-buffered scratch, grown on demand and reused across queries.
let aIdx: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
let aLo: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
let aHi: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
let bIdx: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
let bLo: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
let bHi: Uint32Array<ArrayBufferLike> = new Uint32Array(0);

function ensure(n: number) {
  if (aIdx.length >= n) return;
  aIdx = new Uint32Array(n); aLo = new Uint32Array(n); aHi = new Uint32Array(n);
  bIdx = new Uint32Array(n); bLo = new Uint32Array(n); bHi = new Uint32Array(n);
}

const scratch = new Float64Array(1);
const scratchU32 = new Uint32Array(scratch.buffer);

/** Sort `idx` (in place, length n) by the float values in `vals`. Ascending. */
export function sortFloatIndex(vals: Float64Array, idx: Uint32Array, n: number) {
  if (n < 2) return;
  if (n < 96) {
    const a = Array.from(idx.subarray(0, n));
    a.sort((x, y) => {
      const dx = vals[x];
      const dy = vals[y];
      // NaN last, matching the radix path
      if (Number.isNaN(dx)) return Number.isNaN(dy) ? 0 : 1;
      if (Number.isNaN(dy)) return -1;
      return dx - dy;
    });
    idx.set(a, 0);
    return;
  }

  ensure(n);

  // ---- encode: unsigned ordering == float ordering -----------------------
  let sIdx = aIdx, sLo = aLo, sHi = aHi;
  let dIdx = bIdx, dLo = bLo, dHi = bHi;
  for (let i = 0; i < n; i++) {
    const r = idx[i];
    scratch[0] = vals[r];
    let lo = scratchU32[0];
    let hi = scratchU32[1];
    if (hi & 0x80000000) { lo = ~lo >>> 0; hi = ~hi >>> 0; }
    else { hi = (hi ^ 0x80000000) >>> 0; }
    sIdx[i] = r; sLo[i] = lo; sHi[i] = hi;
  }

  // ---- 4 LSD passes: lo&0xffff, lo>>>16, hi&0xffff, hi>>>16 --------------
  for (let pass = 0; pass < 4; pass++) {
    counts.fill(0);
    const src = pass < 2 ? sLo : sHi;
    const shift = pass & 1 ? 16 : 0;

    for (let i = 0; i < n; i++) counts[(src[i] >>> shift) & MASK]++;

    // Uniform digit -> this pass cannot reorder anything.
    if (counts[(src[0] >>> shift) & MASK] === n) continue;

    let sum = 0;
    for (let d = 0; d < RADIX; d++) {
      const c = counts[d];
      counts[d] = sum;
      sum += c;
    }

    // The low word is dead after pass 1, so stop carrying it.
    if (pass < 2) {
      for (let i = 0; i < n; i++) {
        const j = counts[(src[i] >>> shift) & MASK]++;
        dIdx[j] = sIdx[i]; dLo[j] = sLo[i]; dHi[j] = sHi[i];
      }
    } else {
      for (let i = 0; i < n; i++) {
        const j = counts[(src[i] >>> shift) & MASK]++;
        dIdx[j] = sIdx[i]; dHi[j] = sHi[i];
      }
    }

    let t: Uint32Array<ArrayBufferLike>;
    t = sIdx; sIdx = dIdx; dIdx = t;
    t = sLo; sLo = dLo; dLo = t;
    t = sHi; sHi = dHi; dHi = t;
  }

  idx.set(sIdx.subarray(0, n), 0);
}

/** Counting sort for small integer domains (dictionary codes, booleans). */
export function sortCodeIndex(
  vals: Uint32Array | Uint8Array,
  idx: Uint32Array,
  n: number,
  domain: number,
  nullCode: number,
) {
  // domain+1 buckets; the last collects nulls so they always land at the end.
  const c = new Uint32Array(domain + 2);
  for (let i = 0; i < n; i++) {
    const v = vals[idx[i]];
    c[v === nullCode || v >= domain ? domain : v]++;
  }
  let sum = 0;
  for (let d = 0; d <= domain; d++) {
    const k = c[d];
    c[d] = sum;
    sum += k;
  }
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const r = idx[i];
    const v = vals[r];
    out[c[v === nullCode || v >= domain ? domain : v]++] = r;
  }
  idx.set(out, 0);
}

/** Reverse in place, but keep null entries pinned at the tail. */
export function reverseKeepNullsLast(
  idx: Uint32Array,
  n: number,
  isNull: (row: number) => boolean,
) {
  const out = new Uint32Array(n);
  let write = 0;
  for (let i = n - 1; i >= 0; i--) {
    const r = idx[i];
    if (!isNull(r)) out[write++] = r;
  }
  for (let i = 0; i < n; i++) {
    const r = idx[i];
    if (isNull(r)) out[write++] = r;
  }
  idx.set(out, 0);
}

/** In-place quickselect; returns the k-th smallest. Mutates `a`. */
export function quickselect(a: Float64Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}
