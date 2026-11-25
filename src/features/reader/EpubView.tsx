import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useReader } from './store';
import { usePrefs, type Appearance, type Typography } from '../../state/prefs';
import { sheetStyle, typographyVars } from './ReflowView';
import { ID_PREFIX } from '../../core/epub/sanitize';
import type { EpubBook } from '../../core/epub/book';
import { indexHtml, segmentsFor, wrapSegments, type HtmlTextIndex, type Segment } from '../../core/text/domText';
import { findAll, fold, foldQuery } from '../../core/text/search';
import { epubTitle } from '../../lib/locations';
import { activeEntry } from './currentSection';
import { useElementSize } from '../../lib/useSize';
import type { DocumentRecord, Highlight } from '../../core/types';
import { clamp, cx } from '../../lib/util';

/*
 * Reflowable EPUB reading, in the same three layouts as PDFs:
 *  - continuous: every section stacked as a sheet in one scroll, rendered lazily as it nears view;
 *  - single page / two-page spread: each section paginated into screen pages with CSS columns.
 * Highlights and search hits are drawn by wrapping text ranges in <mark>s; the text itself is
 * never changed, so offsets from the stored section text stay valid.
 *
 * Reading position is always (section, offset) where offset is the fraction of the section before
 * the top of the view — so switching layouts or text size keeps your place.
 */

type Target = { anchor?: string; offset?: number };

/** Find where a highlight sits in the section: its stored anchor if the text still matches, else the first occurrence. */
function locate(text: string, h: Highlight): { start: number; end: number } | null {
  const q = fold(h.text).text.trim();
  if (!q) return null;
  if (h.anchor && text.slice(h.anchor.start, h.anchor.start + q.length) === q) return { start: h.anchor.start, end: h.anchor.start + q.length };
  return findAll(text, q, 1)[0] ?? null;
}

interface Decor {
  highlights: Highlight[];
  flashId: string | null;
  query: string;
  activeIndex: number;
}

/** Everything that changes how a section is painted, narrowed to that section so other sections don't repaint. */
function useSectionDecor(i: number): Decor {
  const highlights = useReader(useShallow((s) => s.highlights.filter((h) => h.page === i)));
  const flashId = useReader((s) => (s.flashHighlight && s.highlights.some((h) => h.id === s.flashHighlight && h.page === i) ? s.flashHighlight : null));
  const query = useReader((s) => (s.searchHits.some((h) => h.page === i) ? s.searchQuery : ''));
  const activeIndex = useReader((s) => {
    const a = s.searchHits[s.searchActive];
    return a && a.page === i ? a.indexOnPage : -1;
  });
  return useMemo(() => ({ highlights, flashId, query, activeIndex }), [highlights, flashId, query, activeIndex]);
}

function paintSection(article: HTMLElement, html: string, d: Decor) {
  article.innerHTML = html;
  const idx = indexHtml(article);
  const groups: { segments: Segment[]; make: () => HTMLElement }[] = [];
  for (const h of d.highlights) {
    const at = locate(idx.folded.text, h);
    if (!at) continue;
    groups.push({
      segments: segmentsFor(idx, at.start, at.end),
      make: () => {
        const m = document.createElement('mark');
        m.dataset.hl = h.id;
        m.className = cx(`hl-${h.color}`, 'cursor-pointer', h.note && 'has-note', d.flashId === h.id && 'flash');
        return m;
      },
    });
  }
  const q = d.query ? foldQuery(d.query) : '';
  if (q)
    findAll(idx.folded.text, q).forEach((m, i) =>
      groups.push({
        segments: segmentsFor(idx, m.start, m.end),
        make: () => {
          const el = document.createElement('mark');
          el.className = cx('search-hit', d.activeIndex === i && 'is-current');
          el.dataset.search = String(i);
          return el;
        },
      }),
    );
  wrapSegments(groups);
}

const byAnchor = (root: ParentNode, anchor: string) => root.querySelector(`[id="${CSS.escape(ID_PREFIX + anchor)}"]`);

/** Internal links go to their section (and anchor); external ones open a new tab. */
function useLinkHandler() {
  return useCallback((e: React.MouseEvent) => {
    const a = (e.target as Element).closest('a');
    if (!a) return;
    if (a.target === '_blank') return; // external: browser opens a new tab
    e.preventDefault();
    const article = a.closest<HTMLElement>('[data-page]');
    const section = Number(a.getAttribute('data-section') ?? article?.dataset.page);
    const anchor = a.getAttribute('data-anchor') ?? undefined;
    if (section) useReader.getState().nav?.goTo(section, { anchor });
  }, []);
}

function useReadingStyle() {
  const typo = usePrefs((s) => s.typography);
  const appearance = usePrefs((s) => s.appearance);
  return { typo, appearance, dark: appearance.invert };
}

export function EpubView({ doc }: { doc: DocumentRecord }) {
  const layout = useReader((s) => s.layout);
  return layout === 'continuous' ? <EpubScroll key="scroll" doc={doc} /> : <EpubPaged key={layout} doc={doc} spread={layout === 'spread'} />;
}

/* ================================================================== *
 * Continuous scroll
 * ================================================================== */

const Sheet = memo(function Sheet({
  i,
  n,
  book,
  shown,
  estimate,
  title,
  bookmarked,
  typo,
  appearance,
  setRef,
  onLink,
}: {
  i: number;
  n: number;
  book: EpubBook;
  shown: boolean;
  estimate: number;
  title: string;
  bookmarked: boolean;
  typo: Typography;
  appearance: Appearance;
  setRef: (el: HTMLElement | null) => void;
  onLink: (e: React.MouseEvent) => void;
}) {
  const articleRef = useRef<HTMLElement>(null);
  const current = useReader((s) => s.page === i);
  const decor = useSectionDecor(i);
  const dark = appearance.invert;
  useLayoutEffect(() => {
    if (shown && articleRef.current) paintSection(articleRef.current, book.sectionHtml(i), decor);
  }, [shown, book, i, decor]);
  return (
    <section
      ref={setRef}
      data-section={i}
      className="relative mx-auto mb-6 overflow-hidden rounded-[3px] px-6 pt-10 pb-14 last:mb-0 sm:px-14"
      style={{ ...sheetStyle(appearance, typo), height: shown ? undefined : estimate }}
      aria-label={title}
    >
      <div className="page-overlay page-texture" />
      {bookmarked && <div className="bookmark-ribbon" aria-label="Bookmarked section" />}
      <div className="mb-8 flex items-center justify-between gap-4 text-[12px]" style={{ color: dark ? '#9b968c' : 'var(--ink-3)' }}>
        <span className="eyebrow truncate" style={{ color: 'inherit' }}>
          {title}
        </span>
        <span className="shrink-0 tabular-nums">
          {i} / {n}
        </span>
      </div>
      {shown && <article ref={articleRef} className="reflow epub" data-page={i} data-testid={current ? 'epub-section' : undefined} style={typographyVars(typo, dark)} onClick={onLink} />}
    </section>
  );
});

function EpubScroll({ doc }: { doc: DocumentRecord }) {
  const book = useReader((s) => s.book)!;
  const set = useReader((s) => s.set);
  const bookmarks = useReader((s) => s.bookmarks);
  const pendingMatch = useReader((s) => s.pendingMatch);
  const flashHighlight = useReader((s) => s.flashHighlight);
  // Re-run the jump logic below once highlights arrive.
  useReader((s) => s.highlights.length);
  const { typo, appearance } = useReadingStyle();
  const n = book.sectionCount;
  const onLink = useLinkHandler();

  const scrollRef = useRef<HTMLDivElement>(null);
  const sheets = useRef<(HTMLElement | null)[]>([]);
  const [rendered, setRendered] = useState(() => {
    const p = useReader.getState().page;
    return new Set([p - 1, p, p + 1].filter((x) => x >= 1 && x <= n));
  });
  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;
  const show = useCallback((p: number) => setRendered((r) => (r.has(p) ? r : new Set(r).add(p))), []);
  const [, setTick] = useState(0);

  // A pending jump, applied once its section is in the DOM; starts with the restored position.
  const pending = useRef<(Target & { page: number }) | null>({ page: useReader.getState().page, offset: useReader.getState().offset });
  // After an explicit jump the current section is the one jumped to, even if it is too short to
  // reach the reading line — until the reader scrolls by hand.
  const lock = useRef<number | null>(useReader.getState().page);
  // Scroll anchor: which section is at the top of the view and how far into it. Restored whenever
  // section heights change (lazy rendering, images, text size), so the text doesn't jump.
  const anchor = useRef<{ page: number; frac: number } | null>(null);
  const flashDone = useRef<string | null>(null);
  // Scroll position Folio set itself. Its scroll event arrives a frame later, possibly after an
  // image or section above has changed height; it must not re-record the anchor from that layout.
  const ownScroll = useRef<number | null>(null);
  const markOwn = () => (ownScroll.current = scrollRef.current?.scrollTop ?? null);

  const setRef = useMemo(() => Array.from({ length: n }, (_, k) => (el: HTMLElement | null) => (sheets.current[k] = el)), [n]);

  const sheetAt = useCallback(
    (y: number) => {
      let lo = 1,
        hi = n;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((sheets.current[mid - 1]?.offsetTop ?? 0) <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [n],
  );

  const recordAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const i = sheetAt(el.scrollTop);
    const s = sheets.current[i - 1];
    if (s) anchor.current = { page: i, frac: (el.scrollTop - s.offsetTop) / Math.max(1, s.offsetHeight) };
  }, [sheetAt]);

  const updatePosition = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const st = useReader.getState();
    const atEnd = el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    const lineY = el.scrollTop + (atEnd ? el.clientHeight - 24 : Math.min(el.clientHeight * 0.3, 120));
    const i = lock.current ?? sheetAt(lineY);
    const s = sheets.current[i - 1];
    if (!s) return;
    const offset = clamp((el.scrollTop - s.offsetTop) / Math.max(1, s.offsetHeight), 0, 1);
    const top = el.getBoundingClientRect().top - el.scrollTop;
    const sectionId = st.doc ? activeEntry(st.doc.outline, i, (a) => byAnchor(s, a), (h) => h.getBoundingClientRect().top - top <= lineY) : null;
    const patch: { page?: number; offset?: number; sectionId?: string | null } = {};
    if (i !== st.page) patch.page = i;
    if (Math.abs(st.offset - offset) > 0.004) patch.offset = offset;
    if (sectionId !== st.sectionId) patch.sectionId = sectionId;
    if (Object.keys(patch).length) set(patch);
  }, [set, sheetAt]);

  /* -------- navigation API -------- */
  useEffect(() => {
    set({
      screen: null,
      nav: {
        goTo: (p, opts = {}) => {
          const page = clamp(Math.round(p), 1, n);
          const st = useReader.getState();
          // A search jump scrolls to its match instead.
          pending.current = st.pendingMatch?.page === page ? null : { page, anchor: opts.anchor, offset: opts.offset ?? 0 };
          lock.current = page;
          if (st.page !== page) set({ page, offset: opts.offset ?? 0 });
          show(page);
          setTick((t) => t + 1);
        },
      },
    });
  }, [n, set, show]);

  /* -------- apply pending jumps, search matches and highlight flashes (after sections paint) -------- */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const st = useReader.getState();
    const done = () => {
      pending.current = null;
      recordAnchor();
      updatePosition();
    };
    const pm = st.pendingMatch;
    if (pm) {
      if (!renderedRef.current.has(pm.page)) return show(pm.page);
      const m = sheets.current[pm.page - 1]?.querySelector(`[data-search="${pm.indexOnPage}"]`);
      set({ pendingMatch: null });
      if (m) {
        lock.current = pm.page;
        m.scrollIntoView({ block: 'center' });
        markOwn();
        return done();
      }
    }
    // Opening at a highlight (from Insights or the notebook). Highlights may still be loading:
    // wait for them rather than giving up.
    const h = flashHighlight && flashDone.current !== flashHighlight ? st.highlights.find((x) => x.id === flashHighlight) : undefined;
    if (h) {
      if (!renderedRef.current.has(h.page)) return show(h.page);
      const m = el.querySelector(`[data-hl="${h.id}"]`);
      flashDone.current = h.id;
      if (m) {
        pending.current = null;
        lock.current = h.page;
        m.scrollIntoView({ block: 'center' });
        markOwn();
        return done();
      }
    }
    const t = pending.current;
    if (t && renderedRef.current.has(t.page)) {
      const s = sheets.current[t.page - 1];
      if (!s) return;
      const a = t.anchor ? byAnchor(s, t.anchor) : null;
      if (a) el.scrollTop += a.getBoundingClientRect().top - el.getBoundingClientRect().top - 24;
      else if (t.offset) el.scrollTop = s.offsetTop + Math.max(0, Math.min(t.offset * s.offsetHeight, s.offsetHeight - el.clientHeight));
      else el.scrollTop = s.offsetTop - 16;
      markOwn();
      done();
    }
  });

  /* -------- lazy rendering -------- */
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        const add = entries.filter((e) => e.isIntersecting).map((e) => Number((e.target as HTMLElement).dataset.section));
        if (add.length) setRendered((r) => (add.every((a) => r.has(a)) ? r : new Set([...r, ...add])));
      },
      { root, rootMargin: '150% 0px' },
    );
    sheets.current.forEach((s) => s && io.observe(s));
    return () => io.disconnect();
  }, [n]);

  /* -------- keep the view anchored while heights change -------- */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const a = anchor.current;
      if (!a || pending.current) return;
      const s = sheets.current[a.page - 1];
      if (!s) return;
      const want = s.offsetTop + a.frac * s.offsetHeight;
      if (Math.abs(el.scrollTop - want) > 1) {
        el.scrollTop = want;
        markOwn();
      }
    });
    sheets.current.forEach((s) => s && ro.observe(s));
    ro.observe(el);
    return () => ro.disconnect();
  }, [n]);

  /* -------- reading position -------- */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      const own = ownScroll.current;
      ownScroll.current = null;
      if (own === null || Math.abs(el.scrollTop - own) > 1) recordAnchor();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(updatePosition);
    };
    // Scrolling by hand releases the section chosen by the last jump.
    const unlock = () => (lock.current = null);
    el.addEventListener('scroll', onScroll, { passive: true });
    const manual = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    manual.forEach((t) => el.addEventListener(t, unlock, { passive: true }));
    // Space / PageDown read on through the book.
    const onPage = (e: Event) => {
      unlock();
      el.scrollBy({ top: (e as CustomEvent<number>).detail * el.clientHeight * 0.88, behavior: 'smooth' });
    };
    window.addEventListener('folio:page-scroll', onPage);
    return () => {
      el.removeEventListener('scroll', onScroll);
      manual.forEach((t) => el.removeEventListener(t, unlock));
      window.removeEventListener('folio:page-scroll', onPage);
      cancelAnimationFrame(raf);
    };
  }, [recordAnchor, updatePosition]);

  // Keyboard scrolling (arrows/Home/End) needs the scroller focused.
  useEffect(() => {
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  // Unrendered sections hold their place with an estimate from the size of their markup.
  const estimate = useCallback(
    (i: number) => {
      const chars = book.sectionSize(i) * 0.55;
      const perLine = Math.max(20, typo.width / (typo.size * 0.5));
      return Math.round(Math.max(320, (chars / perLine) * typo.size * typo.lineHeight * 1.08 + 170));
    },
    [book, typo.width, typo.size, typo.lineHeight],
  );
  const marked = useMemo(() => new Set(bookmarks.map((b) => b.page)), [bookmarks]);
  void pendingMatch; // subscribed so a new search jump re-runs the layout effect above

  return (
    <div ref={scrollRef} tabIndex={-1} className="h-full overflow-y-auto px-3 py-6 outline-none [overflow-anchor:none] sm:px-8 sm:py-10" data-testid="epub-scroll">
      {Array.from({ length: n }, (_, k) => {
        const i = k + 1;
        return (
          <Sheet
            key={i}
            i={i}
            n={n}
            book={book}
            shown={rendered.has(i)}
            estimate={rendered.has(i) ? 0 : estimate(i)}
            title={epubTitle(doc, i) ?? doc.title}
            bookmarked={marked.has(i)}
            typo={typo}
            appearance={appearance}
            setRef={setRef[k]}
            onLink={onLink}
          />
        );
      })}
    </div>
  );
}

/* ================================================================== *
 * Single page and two-page spread
 * ================================================================== */

interface PageGeometry {
  perView: 1 | 2;
  colW: number;
  gap: number;
  padX: number;
  sheetW: number;
  sheetH: number;
  headH: number;
  textH: number;
}

function pageGeometry(width: number, height: number, typo: Typography, spread: boolean): PageGeometry {
  const narrow = width < 640;
  const outerX = narrow ? 10 : 32;
  const outerY = narrow ? 10 : 22;
  const padX = narrow ? 22 : 52;
  const headH = narrow ? 44 : 60;
  const footH = narrow ? 38 : 48;
  // A spread needs room for two comfortable columns; otherwise fall back to one page.
  const perView = spread && width >= 860 ? 2 : 1;
  const room = (width - 2 * outerX) / perView - 2 * padX;
  const colW = Math.floor(Math.max(180, Math.min(perView === 2 ? Math.min(typo.width, 560) : typo.width, room)));
  const sheetH = Math.floor(Math.max(320, height - 2 * outerY));
  return { perView, colW, gap: 2 * padX, padX, sheetW: colW + 2 * padX, sheetH, headH, textH: sheetH - headH - footH };
}

function EpubPaged({ doc, spread }: { doc: DocumentRecord; spread: boolean }) {
  const book = useReader((s) => s.book)!;
  const page = useReader((s) => s.page);
  const set = useReader((s) => s.set);
  const bookmarked = useReader((s) => s.bookmarks.some((b) => b.page === page));
  const { typo, appearance, dark } = useReadingStyle();
  const decor = useSectionDecor(page);
  const onLink = useLinkHandler();
  const n = book.sectionCount;

  const hostRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const size = useElementSize(hostRef);
  const geo = useMemo(() => pageGeometry(size.width, size.height, typo, spread), [size.width, size.height, typo, spread]);
  const geoRef = useRef(geo);
  geoRef.current = geo;

  // Which screen page is showing: first visible column, column count, and whether to animate.
  const [view, setView] = useState({ col: 0, cols: 1, animate: false });
  const viewRef = useRef(view);
  viewRef.current = view;
  const pending = useRef<Target | null>({ offset: useReader.getState().offset });
  const paintedPage = useRef(0);
  const turnDir = useRef<'next' | 'prev' | null>(null);
  const flashDone = useRef<string | null>(null);

  const pitch = geo.colW + geo.gap;
  const columnAt = useCallback((left: number) => {
    const a = articleRef.current!;
    const g = geoRef.current;
    return Math.max(0, Math.floor((left - a.getBoundingClientRect().left + 1) / (g.colW + g.gap)));
  }, []);
  const colOf = useCallback((el: Element) => columnAt(el.getBoundingClientRect().left), [columnAt]);

  /*
   * The place is remembered as a text position — the first character on the visible page — not
   * as a page number, so the same passage stays in view when fonts load, the text size or window
   * changes, or you switch layouts. It is published as a fraction of the section's text.
   */
  const textIdx = useRef<HtmlTextIndex | null>(null);
  const anchorChar = useRef<number | null>(null);
  const textLen = () => textIdx.current?.folded.text.length ?? 0;
  const colOfChar = useCallback(
    (t: number) => {
      const idx = textIdx.current;
      if (!idx || !idx.folded.text.length) return 0;
      const text = idx.folded.text;
      // Spaces at a line break have no reliable position (they can measure on either column).
      let i = clamp(t, 0, text.length - 1);
      while (i < text.length - 1 && /s/.test(text[i])) i++;
      let src = idx.folded.map[i] ?? 0;
      while (src < idx.nodes.length && !idx.nodes[src]) src++;
      const loc = idx.nodes[src];
      if (!loc) return 0;
      const r = document.createRange();
      r.setStart(loc.node, loc.offset);
      r.setEnd(loc.node, Math.min(loc.node.data.length, loc.offset + 1));
      const box = r.getClientRects()[0] ?? r.getBoundingClientRect();
      return columnAt(box.left);
    },
    [columnAt],
  );
  /** First character shown in column `col` (binary search: text runs through columns in order). */
  const charAtCol = useCallback(
    (col: number) => {
      let lo = 0,
        hi = textLen();
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (colOfChar(mid) >= col) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    },
    [colOfChar],
  );

  /** Show the screen page containing column `col` and publish the position. */
  const showCol = useCallback(
    (col: number, cols: number, animate: boolean, keepAnchor = false) => {
      const pv = geoRef.current.perView;
      const last = Math.floor((cols - 1) / pv) * pv;
      const c = clamp(Math.floor(col / pv) * pv, 0, last);
      if (!keepAnchor || anchorChar.current === null) {
        // Anchor on text from the middle of the first visible page: a character at a column's very
        // edge can measure on either side of the break, one in the middle never does.
        const from = charAtCol(c),
          to = charAtCol(c + 1);
        anchorChar.current = to > from ? Math.floor((from + to) / 2) : from;
      }
      setView({ col: c, cols, animate });
      const st = useReader.getState();
      const a = articleRef.current;
      const sectionId = st.doc && a ? activeEntry(st.doc.outline, st.page, (x) => byAnchor(a, x), (h) => colOf(h) < c + pv) : null;
      const len = textLen();
      set({ offset: len ? clamp(anchorChar.current / len, 0, 0.999) : c / cols, screen: { index: c, count: cols, perView: pv }, sectionId });
    },
    [set, colOf, charAtCol],
  );

  /** Re-measure the columns and settle on the right screen page. */
  const relayout = useCallback(() => {
    const a = articleRef.current;
    if (!a) return;
    const end = a.querySelector('.epub-end');
    // The end marker has no height; it can sit in the gap after a full column, so round to the
    // nearest column start rather than flooring.
    const cols = end ? Math.max(1, Math.round((end.getBoundingClientRect().left - a.getBoundingClientRect().left) / (geoRef.current.colW + geoRef.current.gap)) + 1) : Math.max(1, Math.round((a.scrollWidth + geoRef.current.gap) / (geoRef.current.colW + geoRef.current.gap)));
    const st = useReader.getState();
    // Measured with a fallback font while the book's web font is still loading: measure again once it lands.
    if (document.fonts?.status === 'loading' && !fontWait.current) {
      fontWait.current = true;
      void document.fonts.ready.then(() => {
        fontWait.current = false;
        relayoutRef.current();
      });
    }
    const pm = st.pendingMatch;
    if (pm && pm.page === st.page) {
      const m = a.querySelector(`[data-search="${pm.indexOnPage}"]`);
      set({ pendingMatch: null });
      pending.current = null;
      if (m) return showCol(colOf(m), cols, false);
    }
    if (st.flashHighlight && flashDone.current !== st.flashHighlight) {
      const m = a.querySelector(`[data-hl="${st.flashHighlight}"]`);
      if (m) {
        flashDone.current = st.flashHighlight;
        pending.current = null;
        return showCol(colOf(m), cols, false);
      }
    }
    const t = pending.current;
    pending.current = null;
    if (t) {
      const el = t.anchor ? byAnchor(a, t.anchor) : null;
      if (el) return showCol(colOf(el), cols, false);
      if ((t.offset ?? 0) >= 1) return showCol(cols - 1, cols, false);
      // A stored position: find the remembered character and keep it as the anchor.
      anchorChar.current = Math.round((t.offset ?? 0) * textLen());
      return showCol(colOfChar(anchorChar.current), cols, false, true);
    }
    // Same section, new layout (text size, window, fonts, images): keep the same text in view.
    if (anchorChar.current !== null) return showCol(colOfChar(anchorChar.current), cols, false, true);
    showCol(Math.round(st.offset * cols), cols, false);
  }, [colOf, colOfChar, showCol, set]);
  const relayoutRef = useRef(relayout);
  relayoutRef.current = relayout;
  const fontWait = useRef(false);
  // Every batch of web fonts that finishes (regular, italic, headings…) can reflow the pages.
  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts) return;
    const on = () => relayoutRef.current();
    fonts.addEventListener('loadingdone', on);
    return () => fonts.removeEventListener('loadingdone', on);
  }, []);

  /* -------- paint the section -------- */
  useLayoutEffect(() => {
    const a = articleRef.current;
    if (!a || !size.width) return;
    paintSection(a, book.sectionHtml(page), decor);
    const end = document.createElement('div');
    end.className = 'epub-end';
    end.setAttribute('aria-hidden', 'true');
    a.append(end);
    textIdx.current = indexHtml(a);
    if (paintedPage.current !== page) {
      anchorChar.current = null;
      // Turning into another section: a soft page-turn in the direction of travel.
      const dir = turnDir.current ?? (page > paintedPage.current ? 'next' : 'prev');
      turnDir.current = null;
      const b = bookRef.current;
      if (b && paintedPage.current) {
        b.classList.remove('turn-next', 'turn-prev');
        void b.offsetWidth;
        b.classList.add(dir === 'next' ? 'turn-next' : 'turn-prev');
      }
      paintedPage.current = page;
    }
    relayout();
  }, [book, page, decor, geo, size.width, relayout]);

  // Late images and web fonts change how much fits on a page.
  useEffect(() => {
    const a = articleRef.current;
    if (!a) return;
    const imgs = Array.from(a.querySelectorAll('img')).filter((i) => !i.complete);
    imgs.forEach((i) => i.addEventListener('load', relayout, { once: true }));
    return () => imgs.forEach((i) => i.removeEventListener('load', relayout));
  }, [page, relayout, decor]);

  /* -------- navigation API -------- */
  const step = useCallback(
    (dir: 1 | -1) => {
      const { col, cols } = viewRef.current;
      const pv = geoRef.current.perView;
      const st = useReader.getState();
      if (dir > 0) {
        if (col + pv < cols) showCol(col + pv, cols, true);
        else if (st.page < n) {
          turnDir.current = 'next';
          st.nav?.goTo(st.page + 1);
        }
      } else if (col > 0) showCol(col - pv, cols, true);
      else if (st.page > 1) {
        turnDir.current = 'prev';
        st.nav?.goTo(st.page - 1, { offset: 1 });
      }
    },
    [n, showCol],
  );

  useEffect(() => {
    set({
      nav: {
        goTo: (p, opts = {}) => {
          const target = clamp(Math.round(p), 1, n);
          const st = useReader.getState();
          pending.current = st.pendingMatch?.page === target ? null : { anchor: opts.anchor, offset: opts.offset ?? 0 };
          if (target === st.page) relayout();
          else set({ page: target, offset: opts.offset ?? 0 });
        },
        step,
      },
    });
    return () => set({ screen: null });
  }, [n, set, step, relayout]);

  /* -------- wheel, swipe and tap to turn -------- */
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (Math.abs(d) < 8) return;
      e.preventDefault();
      const now = Date.now();
      if (now - last < 450) return;
      last = now;
      step(d > 0 ? 1 : -1);
    };
    let start: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => {
      start = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
    };
    const onUp = (e: PointerEvent) => {
      if (!start || e.pointerType !== 'touch') return;
      const dx = e.clientX - start.x,
        dy = e.clientY - start.y,
        quick = Date.now() - start.t < 350;
      start = null;
      if (window.getSelection()?.toString()) return;
      if (Math.abs(dx) > 50 && Math.abs(dy) < 60) return step(dx < 0 ? 1 : -1);
      // A quick tap near either edge turns the page, as in most e-readers.
      const t = e.target as Element;
      if (quick && Math.abs(dx) < 10 && Math.abs(dy) < 10 && !t.closest('a, mark, button')) {
        const box = el.getBoundingClientRect();
        const x = (e.clientX - box.left) / box.width;
        if (x < 0.2) step(-1);
        else if (x > 0.8) step(1);
      }
    };
    const onCancel = () => (start = null);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
    };
  }, [step]);

  useEffect(() => {
    hostRef.current?.focus({ preventScroll: true });
  }, []);

  const chapter = epubTitle(doc, page) ?? doc.title;
  const { perView, colW, gap, padX, sheetW, sheetH, headH, textH } = geo;
  const { col, cols, animate } = view;
  const muted = dark ? '#9b968c' : 'var(--ink-3)';
  const paper = sheetStyle(appearance, typo);
  const folio = (k: number) => (col + k < cols ? (perView === 1 ? `${col + 1} of ${cols}` : String(col + k + 1)) : '');

  return (
    <div ref={hostRef} tabIndex={-1} className="relative h-full overflow-hidden outline-none [touch-action:pan-y_pinch-zoom]" data-testid="epub-scroll" data-layout={spread ? 'spread' : 'single'}>
      {size.width > 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div ref={bookRef} className="relative flex" style={{ height: sheetH }} data-testid="epub-book">
            {Array.from({ length: perView }, (_, k) => (
              <div
                key={k}
                className={cx('relative overflow-hidden', perView === 1 ? 'rounded-[3px]' : k === 0 ? 'rounded-l-[3px]' : 'rounded-r-[3px]')}
                style={{ width: sheetW, height: sheetH, background: paper.background, boxShadow: paper.boxShadow }}
              >
                <div className="page-overlay page-texture" />
                <div className="absolute inset-x-0 top-0 flex items-end justify-center gap-4 px-6 pb-3 text-[11.5px]" style={{ height: headH, color: muted, paddingLeft: padX, paddingRight: padX }}>
                  <span className="eyebrow truncate" style={{ color: 'inherit' }}>
                    {perView === 2 && k === 0 ? doc.title : chapter}
                  </span>
                </div>
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-center text-[11.5px] tabular-nums" style={{ height: sheetH - headH - textH, color: muted }} data-testid={k === 0 ? 'epub-folio' : undefined}>
                  {folio(k)}
                </div>
              </div>
            ))}
            {perView === 2 && (
              <div aria-hidden className="pointer-events-none absolute inset-y-0 left-1/2 z-[3] w-16 -translate-x-1/2" style={{ background: 'linear-gradient(90deg, transparent, rgb(0 0 0 / 0.06) 46%, rgb(0 0 0 / 0.13) 50%, rgb(0 0 0 / 0.06) 54%, transparent)' }} />
            )}
            {bookmarked && <div className="bookmark-ribbon" aria-label="Bookmarked section" />}
            {/* The text: one column per page, sliding under a window the size of the visible pages. */}
            <div className="absolute z-[2] overflow-hidden [overflow:clip]" style={{ left: padX, top: headH, width: perView * colW + (perView - 1) * gap, height: textH }}>
              <article
                ref={articleRef}
                className="reflow epub paged"
                data-page={page}
                data-testid="epub-section"
                onClick={onLink}
                style={
                  {
                    ...typographyVars(typo, dark),
                    '--page-text-h': `${textH}px`,
                    width: perView * colW + (perView - 1) * gap,
                    height: textH,
                    columnCount: perView,
                    columnGap: gap,
                    transform: `translateX(${-col * pitch}px)`,
                    transition: animate ? 'transform 0.38s cubic-bezier(0.22, 0.8, 0.24, 1)' : 'none',
                  } as React.CSSProperties
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
