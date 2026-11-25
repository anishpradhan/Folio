import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PageView } from './PageView';
import { ReflowView } from './ReflowView';
import { EpubView } from './EpubView';
import { foldedOffsetOf, indexHtml } from '../../core/text/domText';
import { fold } from '../../core/text/search';
import { useReader, spreadOf, MIN_SCALE, MAX_SCALE, type SelectionInfo, type SelectionPart, closePopovers } from './store';
import { useElementSize } from '../../lib/useSize';
import { usePrefs } from '../../state/prefs';
import { clamp, cx } from '../../lib/util';
import { normaliseRects, pointInRects, textRectsOfRange } from '../../core/geometry';
import type { DocumentRecord, Highlight } from '../../core/types';

const PAD_Y = 28;
const padX = (w: number) => (w < 640 ? 8 : 28);

/* ------------------------------------------------------------------ *
 * Fit-to-width / fit-to-page scale computation
 * ------------------------------------------------------------------ */

function medianWidth(sizes: [number, number][]) {
  const ws = sizes.map((s) => s[0]).sort((a, b) => a - b);
  return ws[Math.floor(ws.length / 2)] || 612;
}

function useFitScale(container: { width: number; height: number }, doc: DocumentRecord) {
  const zoomMode = useReader((s) => s.zoomMode);
  const layout = useReader((s) => s.layout);
  const page = useReader((s) => s.page);
  const set = useReader((s) => s.set);
  const readingWidth = usePrefs((s) => s.appearance.readingWidth);

  useLayoutEffect(() => {
    if (zoomMode === 'custom' || !container.width || !container.height) return;
    const sizes = doc.pageSizes;
    let refW: number, refH: number;
    if (layout === 'spread') {
      const pages = spreadOf(page, doc.pageCount);
      refW = pages.reduce((n, p) => n + (sizes[p - 1]?.[0] ?? 612), 0);
      refH = Math.max(...pages.map((p) => sizes[p - 1]?.[1] ?? 792));
    } else if (layout === 'single') {
      [refW, refH] = sizes[page - 1] ?? [612, 792];
    } else {
      refW = medianWidth(sizes);
      refH = Math.max(...sizes.slice(Math.max(0, page - 2), page + 1).map((s) => s[1]));
    }
    const availW = container.width - 2 * padX(container.width) - (container.width > 900 ? 0 : 0);
    const availH = container.height - 2 * PAD_Y;
    let s: number;
    if (zoomMode === 'fit-width') s = Math.min(availW, layout === 'spread' ? readingWidth * 1.7 : readingWidth) / refW;
    else s = Math.min(availW / refW, availH / refH);
    s = clamp(Math.round(s * 1000) / 1000, MIN_SCALE, MAX_SCALE);
    if (Math.abs(s - useReader.getState().scale) > 0.001) set({ scale: s });
    // In continuous mode, only refit when the page size class changes (avoid jitter while scrolling).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomMode, layout, container.width, container.height, readingWidth, doc, layout === 'continuous' ? 0 : page]);
}

/* ------------------------------------------------------------------ *
 * Ctrl/⌘ + wheel (and trackpad pinch) zoom
 * ------------------------------------------------------------------ */
function useWheelZoom(ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const st = useReader.getState();
      const next = clamp(st.scale * Math.exp(-e.deltaY * 0.0025), MIN_SCALE, MAX_SCALE);
      st.set({ scale: next, zoomMode: 'custom' });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref]);
}

/* ------------------------------------------------------------------ *
 * Selection → highlight geometry, and click → highlight hit-testing
 * ------------------------------------------------------------------ */

function sentenceAround(full: string, needle: string): string {
  const flat = full.replace(/\s+/g, ' ');
  const n = needle.replace(/\s+/g, ' ').trim();
  const i = flat.indexOf(n);
  if (i < 0) return n;
  const before = flat.slice(0, i);
  const startCandidates = [before.lastIndexOf('. '), before.lastIndexOf('? '), before.lastIndexOf('! ')];
  const start = Math.max(...startCandidates) + 1;
  const afterIdx = flat.slice(i + n.length).search(/[.?!](\s|$)/);
  const end = afterIdx < 0 ? flat.length : i + n.length + afterIdx + 1;
  const s = flat.slice(Math.max(0, start, i - 240), Math.min(end, i + n.length + 240)).trim();
  return s;
}

function readSelection(root: HTMLElement): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const anchor = range.getBoundingClientRect();

  // Reflow (text) view
  const reflow = (range.commonAncestorContainer as Element).nodeType === 1 ? (range.commonAncestorContainer as Element).closest?.('.reflow') : range.commonAncestorContainer.parentElement?.closest('.reflow');
  if (reflow) {
    const page = Number((reflow as HTMLElement).dataset.page);
    // Remember where in the section the passage starts, so a repeated phrase isn't confused with it.
    const idx = indexHtml(reflow);
    const start = foldedOffsetOf(idx, range.startContainer, range.startOffset);
    const len = fold(text).text.trim().length;
    const at = start >= 0 && idx.folded.text.slice(start, start + len) === fold(text).text.trim() ? { start, end: start + len } : undefined;
    return { text, parts: [{ page, text, rects: [], anchor: at }], anchor, context: sentenceAround(reflow.textContent ?? '', text), reflow: true };
  }

  const layers = Array.from(root.querySelectorAll<HTMLElement>('.textLayer')).filter((l) => range.intersectsNode(l));
  const parts: SelectionPart[] = [];
  let context = '';
  for (const layer of layers) {
    const pageEl = layer.closest<HTMLElement>('.pdf-page');
    if (!pageEl) continue;
    const r = document.createRange();
    if (layer.contains(range.startContainer)) r.setStart(range.startContainer, range.startOffset);
    else r.setStart(layer, 0);
    if (layer.contains(range.endContainer)) r.setEnd(range.endContainer, range.endOffset);
    else r.setEnd(layer, layer.childNodes.length);
    const partText = r.toString().replace(/\s+/g, ' ').trim();
    const rects = normaliseRects(textRectsOfRange(r, layer), pageEl.getBoundingClientRect());
    if (partText && rects.length) parts.push({ page: Number(pageEl.dataset.page), text: partText, rects });
    if (!context) {
      const full = Array.from(layer.querySelectorAll('span, br'))
        .map((n) => (n.tagName === 'BR' ? ' ' : n.textContent))
        .join('');
      context = sentenceAround(full, partText);
    }
  }
  if (!parts.length) return null;
  return { text, parts, anchor, context, reflow: false };
}

function useSelectionHandling(rootRef: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let down: { x: number; y: number; type: string } | null = null;

    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, type: e.pointerType };
      const layer = (e.target as Element).closest?.('.textLayer');
      if (layer && e.pointerType !== 'touch') layer.classList.add('selecting');
    };
    // Touch long-press selection ends in pointercancel (no pointerup) — reset the gesture.
    const onCancel = () => {
      down = null;
      root.querySelectorAll('.textLayer.selecting').forEach((l) => l.classList.remove('selecting'));
    };

    /*
     * Touch screens (Android/iOS) select by long-press and drag selection handles; neither ends in
     * a pointerup on the page. Watch the selection itself instead: once it settles inside the
     * document, show the reader's toolbar. Mouse drags are left to the pointerup path below.
     */
    let settle: ReturnType<typeof setTimeout> | undefined;
    // The selection most recently offered to the reader. Once shown (and possibly acted on —
    // Define, Note…), the same selection must not pop the toolbar back up over the result.
    let shown = '';
    const keyOf = (s: SelectionInfo) => `${s.text}@${Math.round(s.anchor.top)}:${Math.round(s.anchor.left)}`;
    const offer = (info: SelectionInfo) => {
      shown = keyOf(info);
      useReader.getState().set({ selection: info, activeHighlight: null, dictionary: null, aiCard: null });
    };
    const onSelectionChange = () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (down && down.type === 'mouse') return; // a mouse drag is still in progress
        const info = readSelection(root);
        if (!info) {
          shown = ''; // selection cleared: the next one is new
          return; // tapping away is handled by the popover's outside-tap logic
        }
        if (keyOf(info) === shown) return;
        offer(info);
      }, 350);
    };
    const onUp = (e: PointerEvent) => {
      root.querySelectorAll('.textLayer.selecting').forEach((l) => l.classList.remove('selecting'));
      // Only gestures that started in the document count (clicks in popovers/toolbars don't).
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      // Let the browser finalise the selection first.
      setTimeout(() => {
        const st = useReader.getState();
        const info = readSelection(root);
        if (info) {
          offer(info);
          return;
        }
        if (moved > 5) return;
        // A click: did it land on a highlight?
        const pageEl = (e.target as Element).closest?.<HTMLElement>('.pdf-page');
        if (pageEl) {
          const box = pageEl.getBoundingClientRect();
          const x = (e.clientX - box.left) / box.width;
          const y = (e.clientY - box.top) / box.height;
          const page = Number(pageEl.dataset.page);
          const hit = [...st.highlights].reverse().find((h) => h.page === page && pointInRects(x, y, h.rects));
          if (hit) {
            st.set({ activeHighlight: { id: hit.id, anchor: highlightAnchor(hit, box) }, selection: null, dictionary: null });
            return;
          }
        }
        const mark = (e.target as Element).closest?.<HTMLElement>('mark[data-hl]');
        if (mark) {
          st.set({ activeHighlight: { id: mark.dataset.hl!, anchor: mark.getBoundingClientRect() }, selection: null, dictionary: null });
          return;
        }
        if (st.selection || st.activeHighlight || st.dictionary) closePopovers();
      }, 10);
    };
    // Keyboard selections (shift+arrows) also count.
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.shiftKey) return;
      const info = readSelection(root);
      if (info) offer(info);
    };
    // Popovers are anchored in viewport coordinates; dismiss them once the page scrolls away.
    let scrollStart: number | null = null;
    const onScroll = (e: Event) => {
      const st = useReader.getState();
      if (!st.selection && !st.activeHighlight && !st.dictionary) {
        scrollStart = null;
        return;
      }
      const top = (e.target as HTMLElement).scrollTop ?? 0;
      if (scrollStart === null) scrollStart = top;
      else if (Math.abs(top - scrollStart) > 60) {
        scrollStart = null;
        closePopovers();
      }
    };
    root.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    document.addEventListener('selectionchange', onSelectionChange);
    root.addEventListener('keyup', onKeyUp);
    root.addEventListener('scroll', onScroll, true);
    return () => {
      clearTimeout(settle);
      root.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('selectionchange', onSelectionChange);
      root.removeEventListener('keyup', onKeyUp);
      root.removeEventListener('scroll', onScroll, true);
    };
  }, [rootRef]);
}

export function highlightAnchor(h: Highlight, pageBox: DOMRect): DOMRect {
  if (!h.rects.length) return new DOMRect(pageBox.left + pageBox.width / 2, pageBox.top + 80, 0, 0);
  const minX = Math.min(...h.rects.map((r) => r.x)),
    minY = Math.min(...h.rects.map((r) => r.y));
  const maxX = Math.max(...h.rects.map((r) => r.x + r.w)),
    maxY = Math.max(...h.rects.map((r) => r.y + r.h));
  return new DOMRect(pageBox.left + minX * pageBox.width, pageBox.top + minY * pageBox.height, (maxX - minX) * pageBox.width, (maxY - minY) * pageBox.height);
}

/* ------------------------------------------------------------------ *
 * Shared per-page props
 * ------------------------------------------------------------------ */
function usePageProps() {
  const highlights = useReader((s) => s.highlights);
  const bookmarks = useReader((s) => s.bookmarks);
  const searchQuery = useReader((s) => s.searchQuery);
  const searchHits = useReader((s) => s.searchHits);
  const searchActive = useReader((s) => s.searchActive);
  const activeHighlight = useReader((s) => s.activeHighlight?.id ?? null);
  const flashHighlight = useReader((s) => s.flashHighlight);

  const byPage = useMemo(() => {
    const m = new Map<number, Highlight[]>();
    for (const h of highlights) {
      const list = m.get(h.page);
      if (list) list.push(h);
      else m.set(h.page, [h]);
    }
    return m;
  }, [highlights]);
  const marked = useMemo(() => new Set(bookmarks.map((b) => b.page)), [bookmarks]);
  const active = searchHits[searchActive];
  const empty = useMemo<Highlight[]>(() => [], []);

  return (num: number) => ({
    highlights: byPage.get(num) ?? empty,
    bookmarked: marked.has(num),
    searchQuery: searchHits.length ? searchQuery : '',
    activeMatch: active && active.page === num ? active.indexOnPage : -1,
    activeHighlightId: activeHighlight,
    flashHighlightId: flashHighlight,
  });
}

/* ------------------------------------------------------------------ *
 * Continuous (virtualised) scrolling
 * ------------------------------------------------------------------ */

function ContinuousView({ doc }: { doc: DocumentRecord }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  const pdf = useReader((s) => s.pdf)!;
  const scale = useReader((s) => s.scale);
  const set = useReader((s) => s.set);
  const gap = usePrefs((s) => s.appearance.pageGap);
  const pageProps = usePageProps();
  useFitScale(size, doc);
  useWheelZoom(scrollRef);

  const geo = useMemo(() => {
    const n = doc.pageCount;
    const tops = new Float64Array(n),
      hs = new Float64Array(n),
      ws = new Float64Array(n);
    let y = PAD_Y,
      maxW = 0,
      sumH = 0;
    for (let i = 0; i < n; i++) {
      const [w, h] = doc.pageSizes[i] ?? doc.pageSizes[0] ?? [612, 792];
      ws[i] = Math.round(w * scale);
      hs[i] = Math.round(h * scale);
      tops[i] = y;
      y += hs[i] + gap;
      maxW = Math.max(maxW, ws[i]);
      sumH += hs[i];
    }
    return { tops, hs, ws, total: y - gap + PAD_Y, maxW, avgH: sumH / Math.max(1, n), n };
  }, [doc, scale, gap]);

  const lineOffset = useCallback((el: HTMLElement) => Math.min(el.clientHeight * 0.3, geo.avgH * 0.5), [geo]);
  const [range, setRange] = useState<[number, number]>([0, Math.min(2, doc.pageCount - 1)]);

  const findPage = useCallback(
    (y: number) => {
      // last page whose top <= y
      let lo = 0,
        hi = geo.n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (geo.tops[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [geo],
  );

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop,
      vh = el.clientHeight;
    const first = Math.max(0, findPage(top - vh * 0.6));
    const last = Math.min(geo.n - 1, findPage(top + vh * 1.6));
    setRange((r) => (r[0] === first && r[1] === last ? r : [first, last]));
    const line = top + lineOffset(el);
    let cur = findPage(line);
    if (top + vh >= el.scrollHeight - 2 && top > 0) cur = geo.n - 1;
    const offset = clamp((line - geo.tops[cur]) / geo.hs[cur], 0, 1);
    const st = useReader.getState();
    if (st.page !== cur + 1 || Math.abs(st.offset - offset) > 0.004) set({ page: cur + 1, offset });
  }, [findPage, geo, lineOffset, set]);

  // Keep the reading line anchored when the geometry changes (zoom, spacing, resize).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { page, offset } = useReader.getState();
    const i = clamp(page, 1, geo.n) - 1;
    el.scrollTop = geo.tops[i] + offset * geo.hs[i] - lineOffset(el);
    update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo]);

  // Navigation API for this view.
  useEffect(() => {
    set({
      nav: {
        goTo: (page, opts = {}) => {
          const el = scrollRef.current;
          if (!el) return;
          const i = clamp(Math.round(page), 1, geo.n) - 1;
          let target: number;
          if (opts.y !== undefined) target = geo.tops[i] + opts.y * geo.hs[i] - el.clientHeight * 0.3;
          else if (opts.offset !== undefined) target = geo.tops[i] + opts.offset * geo.hs[i] - lineOffset(el);
          else target = geo.tops[i] - Math.min(gap, 16);
          el.scrollTo({ top: Math.max(0, target), behavior: opts.smooth ? 'smooth' : 'auto' });
          update();
        },
      },
    });
  }, [geo, gap, lineOffset, set, update]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    el.addEventListener('scroll', on, { passive: true });
    return () => {
      el.removeEventListener('scroll', on);
      cancelAnimationFrame(raf);
    };
  }, [update]);

  const innerW = Math.max(geo.maxW + 2 * padX(size.width), size.width);
  const pages: number[] = [];
  for (let i = range[0]; i <= range[1]; i++) pages.push(i + 1);

  return (
    <div ref={scrollRef} className="h-full overflow-auto overscroll-contain" data-testid="viewer-scroll" tabIndex={-1}>
      <div className="relative mx-auto" style={{ height: geo.total, width: innerW }}>
        {pages.map((num) => (
          <PageView key={num} pdf={pdf} num={num} scale={scale} width={geo.ws[num - 1]} height={geo.hs[num - 1]} style={{ top: geo.tops[num - 1] }} {...pageProps(num)} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Single page and two-page spread
 * ------------------------------------------------------------------ */

function PagedView({ doc }: { doc: DocumentRecord }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  const pdf = useReader((s) => s.pdf)!;
  const scale = useReader((s) => s.scale);
  const page = useReader((s) => s.page);
  const layout = useReader((s) => s.layout);
  const set = useReader((s) => s.set);
  const pageProps = usePageProps();
  useFitScale(size, doc);
  useWheelZoom(scrollRef);

  const pages = layout === 'spread' ? spreadOf(page, doc.pageCount) : [page];
  const prevFirst = useRef(pages[0]);
  const dir = pages[0] >= prevFirst.current ? 'next' : 'prev';
  const changed = pages[0] !== prevFirst.current;
  useEffect(() => {
    prevFirst.current = pages[0];
  });
  const pendingY = useRef<number | null>(null);

  useEffect(() => {
    set({
      nav: {
        goTo: (p, opts = {}) => {
          const target = clamp(Math.round(p), 1, doc.pageCount);
          pendingY.current = opts.y ?? null;
          set({ page: target, offset: 0 });
          // Same page: scroll immediately.
          if (target === useReader.getState().page) requestAnimationFrame(applyPendingY);
        },
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.pageCount, set]);

  const applyPendingY = () => {
    const el = scrollRef.current;
    if (!el) return;
    const y = pendingY.current;
    pendingY.current = null;
    if (y === null) {
      el.scrollTop = 0;
      return;
    }
    const pageEl = el.querySelector<HTMLElement>(`[data-page="${useReader.getState().page}"]`);
    if (!pageEl) return;
    const box = pageEl.getBoundingClientRect(),
      host = el.getBoundingClientRect();
    el.scrollTop += box.top - host.top + y * box.height - el.clientHeight * 0.3;
  };
  useLayoutEffect(applyPendingY, [page]);

  // Wheel at the edges flips pages; swipe on touch.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let last = 0;
    const step = (d: 1 | -1) => {
      const st = useReader.getState();
      const cur = layout === 'spread' ? spreadOf(st.page, doc.pageCount) : [st.page];
      const next = d > 0 ? cur[cur.length - 1] + 1 : cur[0] - 1;
      if (next >= 1 && next <= doc.pageCount) st.nav?.goTo(next);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) < 8) return;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      const atTop = el.scrollTop <= 0;
      if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return;
      const now = Date.now();
      if (now - last < 450) return;
      last = now;
      step(e.deltaY > 0 ? 1 : -1);
    };
    let start: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') start = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!start || e.pointerType !== 'touch') return;
      const dx = e.clientX - start.x,
        dy = e.clientY - start.y;
      start = null;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 50 && !window.getSelection()?.toString()) step(dx < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
    };
  }, [doc.pageCount, layout]);

  const dims = pages.map((p) => {
    const [w, h] = doc.pageSizes[p - 1] ?? [612, 792];
    return { w: Math.round(w * scale), h: Math.round(h * scale) };
  });
  const contentW = dims.reduce((n, d) => n + d.w, 0) + 2 * padX(size.width);

  return (
    <div ref={scrollRef} className="h-full overflow-auto overscroll-contain" data-testid="viewer-scroll" tabIndex={-1}>
      <div className="flex min-h-full items-center justify-center" style={{ minWidth: contentW, padding: `${PAD_Y}px ${padX(size.width)}px` }}>
        <div key={pages.join('-')} className={cx('relative flex', changed && (dir === 'next' ? 'turn-next' : 'turn-prev'))}>
          {pages.map((p, i) => (
            <PageView key={p} pdf={pdf} num={p} scale={scale} width={dims[i].w} height={dims[i].h} className="inflow" {...pageProps(p)} />
          ))}
          {pages.length === 2 && (
            <div aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 z-[3] w-16 -translate-x-1/2" style={{ background: 'linear-gradient(90deg, transparent, rgb(0 0 0 / 0.07) 48%, rgb(0 0 0 / 0.12) 50%, rgb(0 0 0 / 0.07) 52%, transparent)' }} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function Viewer() {
  const doc = useReader((s) => s.doc)!;
  const layout = useReader((s) => s.layout);
  const view = useReader((s) => s.view);
  const rootRef = useRef<HTMLDivElement>(null);
  useSelectionHandling(rootRef);
  return (
    <div ref={rootRef} className="h-full" data-testid="viewer">
      {doc.format === 'epub' ? <EpubView doc={doc} /> : view === 'reflow' ? <ReflowView doc={doc} /> : layout === 'continuous' ? <ContinuousView doc={doc} /> : <PagedView doc={doc} />}
    </div>
  );
}
