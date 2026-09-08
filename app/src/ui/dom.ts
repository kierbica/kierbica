/** Tiny DOM helpers — enough structure to stay declarative, no framework. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, html?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const n = root.querySelector<T>(sel);
  if (!n) throw new Error(`missing element: ${sel}`);
  return n;
}

export function $$(sel: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll(sel));
}

export function on<K extends keyof HTMLElementEventMap>(
  n: EventTarget, ev: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions,
) {
  n.addEventListener(ev, fn as EventListener, opts);
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function icon(name: string): string {
  const p: Record<string, string> = {
    table: '<path d="M3 5h18v14H3z"/><path d="M3 10h18M9 10v9"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    scatter: '<circle cx="6" cy="16" r="2"/><circle cx="12" cy="8" r="2"/><circle cx="18" cy="13" r="2"/><circle cx="9" cy="19" r="1.4"/>',
    grid4: '<path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    download: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16"/>',
    upload: '<path d="M12 20V8M7 12l5-5 5 5M4 4h16"/>',
    dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
    cmd: '<path d="M6 3a3 3 0 100 6h12a3 3 0 100-6 3 3 0 00-3 3v12a3 3 0 106 0 3 3 0 00-3-3H6a3 3 0 100 6 3 3 0 003-3V6a3 3 0 00-3-3z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    left: '<path d="M15 5l-7 7 7 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
    sort: '<path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/>',
    reset: '<path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8"/><path d="M3 3v5h5"/>',
    zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p[name] ?? ''}</svg>`;
}

/** Coalesce rapid calls into one rAF-aligned invocation. */
export function raf(fn: () => void) {
  let q = false;
  return () => {
    if (q) return;
    q = true;
    requestAnimationFrame(() => { q = false; fn(); });
  };
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: number | undefined;
  return ((...a: any[]) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  }) as T;
}
