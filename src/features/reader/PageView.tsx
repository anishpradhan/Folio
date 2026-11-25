import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { pdfjs, type PDFDocumentProxy } from '../../core/pdf/pdfjs';
import { getTextContent } from '../../core/pdf/textCache';
import { findAll, fold, foldQuery, indexTextLayer, rangeFor } from '../../core/text/search';
import { normaliseRects, textRectsOfRange } from '../../core/geometry';
import type { Highlight, NormRect } from '../../core/types';
import { updateHighlight } from '../../data/repo';
import { cx } from '../../lib/util';
import { useReader } from './store';

interface Props {
  pdf: PDFDocumentProxy;
  num: number;
  /** CSS px per PDF point. */
  scale: number;
  width: number;
  height: number;
  style?: CSSProperties;
  className?: string;
  highlights: Highlight[];
  bookmarked: boolean;
  searchQuery: string;
  /** Index of the current search match on this page, or -1. */
  activeMatch: number;
  activeHighlightId: string | null;
  flashHighlightId: string | null;
}

const MAX_CANVAS_PIXELS = 12_000_000;

/**
 * One PDF page: canvas (rendered at device resolution), selectable text layer, highlight and
 * search overlays. Re-renders are debounced while zooming; the old bitmap stays visible (stretched)
 * until the sharp one is ready, so zoom feels immediate.
 */
export const PageView = memo(function PageView({ pdf, num, scale, width, height, style, className, highlights, bookmarked, searchQuery, activeMatch, activeHighlightId, flashHighlightId }: Props) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textHost = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [failed, setFailed] = useState(false);
  const [textVersion, setTextVersion] = useState(0);
  const [searchRects, setSearchRects] = useState<NormRect[][]>([]);
  const renderedOnce = useRef(false);

  /* ---------------- canvas ---------------- */
  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    const timer = setTimeout(
      async () => {
        try {
          const page = await pdf.getPage(num);
          if (cancelled) return;
          const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
          let k = scale * dpr;
          const base = page.getViewport({ scale: 1 });
          const px = base.width * base.height * k * k;
          if (px > MAX_CANVAS_PIXELS) k *= Math.sqrt(MAX_CANVAS_PIXELS / px);
          const viewport = page.getViewport({ scale: k });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext('2d', { alpha: false })!;
          task = page.render({ canvasContext: ctx, viewport });
          await task.promise;
          if (cancelled) return;
          canvasHost.current?.replaceChildren(canvas);
          renderedOnce.current = true;
          setRendered(true);
          setFailed(false);
        } catch (e) {
          if (cancelled || (e as Error)?.name === 'RenderingCancelledException') return;
          console.error('[folio] page render failed', num, e);
          setFailed(true);
        }
      },
      renderedOnce.current ? 140 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [pdf, num, scale]);

  /* ---------------- text layer ---------------- */
  useEffect(() => {
    let cancelled = false;
    let layer: InstanceType<typeof pdfjs.TextLayer> | null = null;
    const timer = setTimeout(async () => {
      try {
        const [page, content] = await Promise.all([pdf.getPage(num), getTextContent(pdf, num)]);
        const host = textHost.current;
        if (cancelled || !host) return;
        const viewport = page.getViewport({ scale });
        const fresh = document.createElement('div');
        layer = new pdfjs.TextLayer({ textContentSource: content, container: fresh, viewport });
        await layer.render();
        if (cancelled) return;
        const end = document.createElement('div');
        end.className = 'endOfContent';
        fresh.append(end);
        host.replaceChildren(...Array.from(fresh.childNodes));
        host.style.width = fresh.style.width;
        host.style.height = fresh.style.height;
        setTextVersion((v) => v + 1);
      } catch (e) {
        if (!cancelled) console.warn('[folio] text layer failed', num, e);
      }
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      layer?.cancel();
    };
  }, [pdf, num, scale]);

  /* ---------------- search overlay ---------------- */
  useLayoutEffect(() => {
    const host = textHost.current;
    const pageEl = pageRef.current;
    if (!host || !pageEl || !textVersion) return;
    const q = foldQuery(searchQuery);
    if (!q) {
      setSearchRects([]);
      return;
    }
    const idx = indexTextLayer(host);
    const box = pageEl.getBoundingClientRect();
    const rects = findAll(idx.folded.text, q).map((m) => {
      const r = rangeFor(idx, m.start, m.end);
      return r ? normaliseRects(textRectsOfRange(r, host), box) : [];
    });
    setSearchRects(rects);
  }, [searchQuery, textVersion]);

  // Scroll a pending search match into view once we know exactly where it is.
  const pending = useReader((s) => (s.pendingMatch?.page === num ? s.pendingMatch : null));
  useEffect(() => {
    if (!pending) return;
    const r = searchRects[pending.indexOnPage]?.[0];
    if (!r) return;
    const st = useReader.getState();
    st.set({ pendingMatch: null });
    st.nav?.goTo(num, { y: r.y });
  }, [pending, searchRects, num]);

  /* ---------------- cited passage (from an answer in the Ask tab) ---------------- */
  const citation = useReader((s) => (s.citationFlash?.locations.some((l) => l.page === num) ? s.citationFlash : null));
  const [citeRects, setCiteRects] = useState<{ key: number; rects: NormRect[] } | null>(null);
  useLayoutEffect(() => {
    if (!citation) {
      setCiteRects(null);
      return;
    }
    const boxes = citation.locations.filter((l) => l.page === num).map((l) => l.rect);
    const host = textHost.current;
    const pageEl = pageRef.current;
    let rects = boxes;
    if (host && pageEl && textVersion) {
      // Prefer the exact quoted lines; long quotes may wrap differently, so fall back to their start.
      const idx = indexTextLayer(host);
      const q = fold(citation.quote).text.trim();
      const m = findAll(idx.folded.text, q, 1)[0] ?? (q.length > 80 ? findAll(idx.folded.text, q.slice(0, 80), 1)[0] : undefined);
      const r = m ? rangeFor(idx, m.start, m.end) : null;
      if (r) rects = normaliseRects(textRectsOfRange(r, host), pageEl.getBoundingClientRect());
    }
    setCiteRects({ key: citation.key, rects });
  }, [citation, textVersion, num]);

  /* ---------------- resolve text-only highlights (made in text view) ---------------- */
  useEffect(() => {
    const host = textHost.current;
    const pageEl = pageRef.current;
    if (!host || !pageEl || !textVersion) return;
    const unresolved = highlights.filter((h) => !h.rects.length);
    if (!unresolved.length) return;
    const idx = indexTextLayer(host);
    const box = pageEl.getBoundingClientRect();
    for (const h of unresolved) {
      const q = fold(h.text).text;
      const m = findAll(idx.folded.text, q, 1)[0];
      if (!m) continue;
      const r = rangeFor(idx, m.start, m.end);
      if (r) void updateHighlight(h.id, { rects: normaliseRects(textRectsOfRange(r, host), box) });
    }
  }, [highlights, textVersion]);

  const pct = (v: number) => `${v * 100}%`;
  return (
    <div
      ref={pageRef}
      className={cx('pdf-page', className)}
      data-page={num}
      style={{ width, height, ['--scale-factor' as string]: scale, ...style }}
      aria-label={`Page ${num}`}
      role="region"
    >
      <div className="page-surface">
        <div ref={canvasHost} className="absolute inset-0 [&>canvas]:h-full [&>canvas]:w-full" />
        {!rendered && !failed && <div className="placeholder" />}
        {failed && <div className="absolute inset-0 grid place-items-center text-[12px] text-neutral-500">This page couldn't be rendered.</div>}
        <div className="page-overlay page-warmth" />
        <div className="page-overlay page-texture" />
      </div>
      <div className="hl-layer" aria-hidden>
        {highlights.map((h) =>
          h.rects.map((r, i) => (
            <div
              key={`${h.id}-${i}`}
              data-hl={h.id}
              className={cx('hl-rect', `hl-${h.color}`, activeHighlightId === h.id && 'is-active', flashHighlightId === h.id && 'flash', h.note && i === h.rects.length - 1 && 'has-note')}
              style={{ left: pct(r.x), top: pct(r.y - r.h * 0.08), width: pct(r.w), height: pct(r.h * 1.16) }}
            />
          )),
        )}
      </div>
      {searchRects.length > 0 && (
        <div className="pointer-events-none absolute inset-0 z-[1]" aria-hidden>
          {searchRects.map((rs, i) => rs.map((r, k) => <div key={`${i}-${k}`} className={cx('search-rect', i === activeMatch && 'is-current')} style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }} />))}
        </div>
      )}
      {citeRects && citeRects.rects.length > 0 && (
        <div className="pointer-events-none absolute inset-0 z-[1]" aria-hidden data-testid="citation-flash" data-page={num}>
          {citeRects.rects.map((r, i) => (
            <div key={`${citeRects.key}-${i}`} className="cite-rect" style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }} />
          ))}
        </div>
      )}
      <div ref={textHost} className="textLayer" />
      {bookmarked && <div className="bookmark-ribbon" aria-label="Bookmarked page" />}
    </div>
  );
});
