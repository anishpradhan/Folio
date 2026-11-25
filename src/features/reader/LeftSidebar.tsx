import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Search, X, ChevronUp, ChevronDown, ListTree, Bookmark as BookmarkIcon } from 'lucide-react';
import { useReader } from './store';
import { usePrefs, type LeftTab } from '../../state/prefs';
import { cx, formatDate } from '../../lib/util';
import type { DocumentRecord, OutlineNode } from '../../core/types';
import { useCurrentSection } from './currentSection';
import { useLive } from '../../data/useLive';
import { getPageTexts } from '../../data/repo';
import { getPageTextLive } from '../../core/pdf/textCache';
import { searchPages } from '../../core/text/search';
import { Spinner } from '../../components/ui';
import { locLong, unitWord } from '../../lib/locations';
import type { PDFDocumentProxy } from '../../core/pdf/pdfjs';

/* ============================== Contents ============================== */

function containsPage(node: OutlineNode, id: string): boolean {
  return node.id === id || node.children.some((c) => containsPage(c, id));
}

function OutlineItem({ node, depth, currentId, label }: { node: OutlineNode; depth: number; currentId: string | null; label: (p: number) => string }) {
  const onPath = currentId ? containsPage(node, currentId) : false;
  const [open, setOpen] = useState(depth === 0 ? onPath || node.children.length < 8 : onPath);
  useEffect(() => {
    if (onPath) setOpen(true);
  }, [onPath]);
  const current = node.id === currentId;
  return (
    <li>
      <div className={cx('group flex items-center rounded-lg transition-colors', current ? 'bg-accent/10' : 'hover:bg-ink/[0.04]')} style={{ paddingLeft: depth * 14 }}>
        {node.children.length ? (
          <button aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open} onClick={() => setOpen(!open)} className="grid h-7 w-6 shrink-0 place-items-center text-ink-3 hover:text-ink">
            <ChevronRight size={13} className={cx('transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}
        <button
          disabled={node.page == null}
          onClick={() => node.page && useReader.getState().nav?.goTo(node.page, node.anchor ? { anchor: node.anchor } : undefined)}
          className={cx(
            'flex min-w-0 flex-1 items-baseline gap-2 py-1.5 pr-2 text-left',
            depth === 0 ? 'font-serif text-[13.5px]' : 'text-[12.5px]',
            current ? 'font-medium text-accent' : depth === 0 ? 'text-ink' : 'text-ink-2',
          )}
          aria-current={current ? 'location' : undefined}
        >
          <span className="min-w-0 flex-1 leading-snug">{node.title}</span>
          {node.page != null && label(node.page) && <span className="shrink-0 text-[11px] text-ink-3 tabular-nums">{label(node.page)}</span>}
        </button>
      </div>
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <OutlineItem key={c.id} node={c} depth={depth + 1} currentId={currentId} label={label} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ContentsPanel({ doc }: { doc: DocumentRecord }) {
  const page = useReader((s) => s.page);
  const current = useCurrentSection(doc, page);
  // Reflowable books have no page numbers worth showing next to chapters.
  const label = (p: number) => (doc.format === 'epub' ? '' : (doc.pageLabels?.[p - 1] ?? String(p)));
  const texts = useLive(() => (doc.outline.length ? Promise.resolve([]) : getPageTexts(doc.id)), ['pages'], [doc.id, doc.outline.length]);

  if (doc.outline.length)
    return (
      <nav aria-label="Table of contents" className="px-2 pb-6">
        <ul>
          {doc.outline.map((n) => (
            <OutlineItem key={n.id} node={n} depth={0} currentId={current?.id ?? null} label={label} />
          ))}
        </ul>
      </nav>
    );

  // No embedded outline: show real metadata and the page structure — never invented chapters.
  const meta: [string, string][] = (
    [
      ['Title', doc.title],
      ['Author', doc.author],
      ['Subject', doc.subject],
      ['Keywords', doc.keywords],
      ['Created', doc.createdDate ? formatDate(Date.parse(doc.createdDate)) : ''],
      ['Pages', String(doc.pageCount)],
      ['Producer', doc.producer],
    ] as [string, string][]
  ).filter(([, v]) => v);
  const firstLine = (t: string) => t.split('\n').find((l) => l.trim().length > 2)?.trim() ?? '';
  return (
    <div className="px-4 pb-6">
      <div className="mb-4 flex gap-3 rounded-xl bg-ink/[0.035] p-3.5 text-[12.5px] leading-relaxed text-ink-2">
        <ListTree size={16} className="mt-0.5 shrink-0 text-ink-3" />
        <p>This document doesn’t include a table of contents. Below are its details and {unitWord(doc)}s, as written.</p>
      </div>
      <dl className="mb-5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        {meta.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="min-w-0 break-words text-ink-2">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="eyebrow mb-2">Pages</div>
      <ul className="-mx-2">
        {Array.from({ length: doc.pageCount }, (_, i) => i + 1).map((p) => {
          const t = texts?.[p - 1]?.page === p ? firstLine(texts[p - 1].text) : '';
          return (
            <li key={p}>
              <button
                onClick={() => useReader.getState().nav?.goTo(p)}
                className={cx('flex w-full items-baseline gap-3 rounded-lg px-2 py-1.5 text-left text-[12.5px]', p === page ? 'bg-accent/10 text-accent' : 'text-ink-2 hover:bg-ink/[0.04]')}
              >
                <span className="w-8 shrink-0 text-ink-3 tabular-nums">{label(p)}</span>
                <span className="min-w-0 truncate">{t || <span className="text-ink-3 italic">Page {p}</span>}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ============================== Thumbnails ============================== */

const thumbCache = new WeakMap<PDFDocumentProxy, Map<number, string>>();
let thumbQueue: (() => Promise<void>)[] = [];
let thumbActive = 0;
function enqueue(job: () => Promise<void>) {
  thumbQueue.push(job);
  pump();
}
function pump() {
  while (thumbActive < 2 && thumbQueue.length) {
    const job = thumbQueue.pop()!; // LIFO: most recently scrolled-to first
    thumbActive++;
    void job().finally(() => {
      thumbActive--;
      pump();
    });
  }
}

function Thumb({ pdf, num, ratio, current, bookmarked, label }: { pdf: PDFDocumentProxy; num: number; ratio: number; current: boolean; bookmarked: boolean; label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const cache = thumbCache.get(pdf) ?? (thumbCache.set(pdf, new Map()), thumbCache.get(pdf)!);
  const [src, setSrc] = useState<string | null>(cache.get(num) ?? null);

  useEffect(() => {
    if (src) return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        io.disconnect();
        enqueue(async () => {
          if (cancelled) return;
          try {
            const page = await pdf.getPage(num);
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: (220 / base.width) * 1 });
            const c = document.createElement('canvas');
            c.width = Math.floor(viewport.width);
            c.height = Math.floor(viewport.height);
            await page.render({ canvasContext: c.getContext('2d', { alpha: false })!, viewport }).promise;
            const url = c.toDataURL('image/jpeg', 0.75);
            cache.set(num, url);
            if (!cancelled) setSrc(url);
          } catch {
            /* destroyed or cancelled */
          }
        });
      },
      { rootMargin: '200px 0px' },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [pdf, num, src, cache]);

  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  return (
    <button ref={ref} onClick={() => useReader.getState().nav?.goTo(num)} className="group flex flex-col items-center gap-1.5" aria-label={`Go to page ${label}`} aria-current={current ? 'page' : undefined} data-testid="thumb">
      <div className={cx('relative w-full overflow-hidden rounded-[3px] bg-white shadow-soft transition-all', current ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : 'group-hover:ring-1 group-hover:ring-line-2')} style={{ aspectRatio: `1 / ${ratio}` }}>
        {src ? <img src={src} alt="" className="h-full w-full object-cover anim-fade" /> : <div className="h-full w-full animate-pulse bg-black/[0.03]" />}
        {bookmarked && <BookmarkIcon size={14} className="absolute top-0 right-1.5 fill-accent text-accent" />}
      </div>
      <span className={cx('text-[11px] tabular-nums', current ? 'font-semibold text-accent' : 'text-ink-3')}>{label}</span>
    </button>
  );
}

function PagesPanel({ doc }: { doc: DocumentRecord }) {
  const pdf = useReader((s) => s.pdf)!;
  const page = useReader((s) => s.page);
  const bookmarks = useReader((s) => s.bookmarks);
  const marked = useMemo(() => new Set(bookmarks.map((b) => b.page)), [bookmarks]);
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-4 px-5 pb-8">
      {doc.pageSizes.map(([w, h], i) => (
        <Thumb key={i} pdf={pdf} num={i + 1} ratio={h / w} current={page === i + 1} bookmarked={marked.has(i + 1)} label={doc.pageLabels?.[i] ?? String(i + 1)} />
      ))}
    </div>
  );
}

/* ============================== Search ============================== */

function SearchPanel({ doc }: { doc: DocumentRecord }) {
  const pdf = useReader((s) => s.pdf);
  const hits = useReader((s) => s.searchHits);
  const active = useReader((s) => s.searchActive);
  const status = useReader((s) => s.searchStatus);
  const storedQuery = useReader((s) => s.searchQuery);
  const set = useReader((s) => s.set);
  const [q, setQ] = useState(storedQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scanned, setScanned] = useState(0);

  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    focus();
    window.addEventListener('folio:focus-search', focus);
    return () => window.removeEventListener('folio:focus-search', focus);
  }, []);

  // Run the search (debounced). Uses the stored text index and fills gaps live from the PDF.
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      set({ searchQuery: '', searchHits: [], searchActive: -1, searchStatus: 'idle' });
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      set({ searchStatus: 'searching' });
      const stored = await getPageTexts(doc.id);
      const byPage = new Map(stored.map((p) => [p.page, p.text]));
      const pages: { page: number; text: string }[] = [];
      for (let p = 1; p <= doc.pageCount; p++) {
        let text = byPage.get(p);
        if (text === undefined) {
          text = pdf ? await getPageTextLive(pdf, p).catch(() => '') : '';
          if (cancelled) return;
          if (p % 25 === 0) setScanned(p);
        }
        pages.push({ page: p, text });
      }
      if (cancelled) return;
      const found = searchPages(pages, query);
      // No match is "current" until the reader steps to one; all matches are marked on the pages.
      set({ searchQuery: query, searchHits: found, searchActive: -1, searchStatus: 'done' });
      setScanned(0);
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, doc.id, doc.pageCount, pdf, set]);

  const go = (i: number) => {
    const h = hits[i];
    if (!h) return;
    set({ searchActive: i, pendingMatch: { page: h.page, indexOnPage: h.indexOnPage } });
    useReader.getState().nav?.goTo(h.page);
    listRef.current?.querySelector(`[data-hit="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const step = (d: 1 | -1) => {
    if (!hits.length) return;
    if (active < 0) {
      // Start from the current page.
      const cur = useReader.getState().page;
      const i = d > 0 ? hits.findIndex((h) => h.page >= cur) : hits.length - 1 - [...hits].reverse().findIndex((h) => h.page <= cur);
      return go(i < 0 || i >= hits.length ? 0 : i);
    }
    go((active + d + hits.length) % hits.length);
  };

  const pagesWithHits = new Set(hits.map((h) => h.page)).size;
  let lastPage = -1;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pb-3">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
              if (e.key === 'Escape') setQ('');
            }}
            placeholder="Find in document"
            aria-label="Find in document"
            data-testid="search-input"
            className="field h-9 pr-8 pl-9 text-[13px]"
          />
          {q && (
            <button className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-3 hover:text-ink" aria-label="Clear search" onClick={() => setQ('')}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="mt-2.5 flex h-7 items-center justify-between text-[12px] text-ink-3">
          <span data-testid="search-count" aria-live="polite">
            {status === 'searching' ? (
              <span className="inline-flex items-center gap-2">
                <Spinner size={12} /> {scanned ? `Reading page ${scanned}…` : 'Searching…'}
              </span>
            ) : status === 'done' ? (
              hits.length ? (
                <>
                  {active >= 0 && <span className="text-ink-2">{active + 1} of </span>}
                  {hits.length} {hits.length === 1 ? 'match' : 'matches'} · {pagesWithHits} {pagesWithHits === 1 ? 'page' : 'pages'}
                </>
              ) : (
                'No matches'
              )
            ) : (
              'Type to search every page'
            )}
          </span>
          <span className="flex">
            <button className="icon-btn h-7 w-7" aria-label="Previous match" data-tip="Previous match" data-tip-key="⇧↵" disabled={!hits.length} onClick={() => step(-1)}>
              <ChevronUp size={15} />
            </button>
            <button className="icon-btn h-7 w-7" aria-label="Next match" data-tip="Next match" data-tip-key="↵" disabled={!hits.length} onClick={() => step(1)} data-testid="search-next">
              <ChevronDown size={15} />
            </button>
          </span>
        </div>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-6" data-testid="search-results">
        {hits.slice(0, 600).map((h, i) => {
          const header = h.page !== lastPage;
          lastPage = h.page;
          return (
            <div key={i}>
              {header && <div className="eyebrow px-2 pt-3 pb-1 text-[10px]">{locLong(doc, h.page)}</div>}
              <button
                data-hit={i}
                onClick={() => go(i)}
                className={cx('block w-full rounded-lg px-2.5 py-2 text-left font-serif text-[13px] leading-relaxed transition-colors', i === active ? 'bg-accent/10 text-ink' : 'text-ink-2 hover:bg-ink/[0.04]')}
                data-testid="search-result"
              >
                <span>{h.before}</span>
                <mark className="rounded-sm bg-[rgb(255_196_0/0.4)] px-0.5 text-ink">{h.match}</mark>
                <span>{h.after}</span>
              </button>
            </div>
          );
        })}
        {hits.length > 600 && <p className="px-3 py-2 text-[12px] text-ink-3">Showing the first 600 matches. Refine your search to narrow it down.</p>}
      </div>
    </div>
  );
}

/* ============================== Sidebar ============================== */

const TABS: { id: LeftTab; label: string }[] = [
  { id: 'contents', label: 'Contents' },
  { id: 'pages', label: 'Pages' },
  { id: 'search', label: 'Search' },
];

export function LeftSidebar({ overlay }: { overlay: boolean }) {
  const doc = useReader((s) => s.doc)!;
  const focus = useReader((s) => s.focus);
  const open = usePrefs((s) => s.leftOpen) && !focus;
  const tab = usePrefs((s) => s.leftTab);
  const epub = doc.format === 'epub';
  // Page thumbnails don't exist for reflowable books.
  const activeTab = epub && tab === 'pages' ? 'contents' : tab;
  const set = usePrefs((s) => s.set);
  if (!open) return null;
  return (
    <aside
      className={cx('flex w-[300px] shrink-0 flex-col border-r border-line bg-bg', overlay ? 'absolute inset-y-0 left-0 z-30 shadow-pop anim-fade' : 'relative')}
      aria-label="Document navigation"
      data-testid="left-sidebar"
    >
      <div role="tablist" className="flex gap-5 border-b border-line px-5 pt-3">
        {TABS.filter((t) => !(epub && t.id === 'pages')).map((t) => (
          <button key={t.id} role="tab" aria-selected={activeTab === t.id} className="tab pb-2.5" onClick={() => set({ leftTab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      <div className={cx('min-h-0 flex-1 pt-3', activeTab === 'search' ? 'flex flex-col' : 'overflow-y-auto')}>
        {activeTab === 'contents' && <ContentsPanel doc={doc} />}
        {activeTab === 'pages' && <PagesPanel doc={doc} />}
        {activeTab === 'search' && <SearchPanel doc={doc} />}
      </div>
    </aside>
  );
}
