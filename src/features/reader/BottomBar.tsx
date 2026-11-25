import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useReader, spreadOf } from './store';
import { firstPage, lastPage, stepPage } from './actions';
import { IconButton } from '../../components/ui';
import { usePrefs, prettyCombo } from '../../state/prefs';
import { flattenOutline } from '../../core/pdf/indexText';
import { cx } from '../../lib/util';
import { locShort } from '../../lib/locations';

export function BottomBar() {
  const doc = useReader((s) => s.doc)!;
  const page = useReader((s) => s.page);
  const layout = useReader((s) => s.layout);
  const view = useReader((s) => s.view);
  const focus = useReader((s) => s.focus);
  const bookmarks = useReader((s) => s.bookmarks);
  const shortcuts = usePrefs((s) => s.shortcuts);
  const [draft, setDraft] = useState<string | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [peek, setPeek] = useState(false);
  const n = doc.pageCount;

  const epub = doc.format === 'epub';
  const offset = useReader((s) => (epub ? s.offset : 0));
  // Paginated books: the screen page within the current section.
  const screen = useReader((s) => (epub ? s.screen : null));

  const shown = !epub && view === 'original' && layout === 'spread' ? spreadOf(page, n) : [page];
  const canBack = epub ? page > 1 || (screen?.index ?? 0) > 0 : shown[0] > 1;
  const canOn = epub ? page < n || (!!screen && screen.index + screen.perView < screen.count) : shown[shown.length - 1] < n;
  const label = (p: number) => doc.pageLabels?.[p - 1] ?? String(p);
  // EPUB progress also counts how far into the current section you've scrolled.
  const read = screen ? Math.min(1, (screen.index + screen.perView) / screen.count) : offset;
  const pct = epub ? Math.round(((page - 1 + read) / n) * 100) : Math.round((shown[shown.length - 1] / n) * 100);

  const sectionStarts = useMemo(
    () =>
      flattenOutline(doc.outline)
        .map((f) => f.node.page)
        .filter((p): p is number => p != null)
        .sort((a, b) => a - b),
    [doc.outline],
  );
  const nextSection = sectionStarts.find((p) => p > page);
  const leftInSection = !epub && nextSection ? nextSection - page : null;

  useEffect(() => {
    if (!focus) return setPeek(false);
    const on = (e: PointerEvent) => setPeek(e.clientY > window.innerHeight - 70);
    window.addEventListener('pointermove', on);
    return () => window.removeEventListener('pointermove', on);
  }, [focus]);

  const commit = () => {
    if (draft === null) return;
    const v = draft.trim();
    setDraft(null);
    // Accept page labels ("iv") as well as numbers.
    const byLabel = doc.pageLabels?.findIndex((l) => l.toLowerCase() === v.toLowerCase()) ?? -1;
    const p = byLabel >= 0 ? byLabel + 1 : parseInt(v, 10);
    if (Number.isFinite(p)) useReader.getState().nav?.goTo(Math.min(n, Math.max(1, p)));
  };

  const scrubPage = scrub ?? page;
  return (
    <>
      {focus && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[2px] bg-ink/5" aria-hidden>
          <div className="h-full bg-accent/60 transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
      <footer
        className={cx(
          'z-30 flex h-[48px] shrink-0 items-center gap-1 border-t border-line bg-bg/95 px-2 backdrop-blur transition-all duration-300 sm:gap-2 sm:px-3',
          focus && 'absolute inset-x-0 bottom-0',
          focus && !peek && 'pointer-events-none translate-y-full opacity-0',
        )}
        aria-label="Page navigation"
      >
        <IconButton label="First page" shortcut={prettyCombo(shortcuts.firstPage)} onClick={firstPage} disabled={page <= 1} className="hidden sm:inline-grid">
          <ChevronsLeft size={16} />
        </IconButton>
        <IconButton label={epub && !screen ? 'Previous section' : 'Previous page'} shortcut={prettyCombo(shortcuts.prevPage)} onClick={() => stepPage(-1)} disabled={!canBack} data-testid="prev-page">
          <ChevronLeft size={17} />
        </IconButton>
        <div className="flex items-center gap-1.5 text-[12.5px] text-ink-3 tabular-nums">
          <input
            aria-label={epub ? "Section number" : "Page number"}
            data-testid="page-input"
            className="h-7 w-[46px] rounded-md bg-ink/[0.05] text-center text-[12.5px] font-medium text-ink outline-none focus:bg-surface focus:ring-2 focus:ring-accent/25"
            value={draft ?? (shown.length > 1 ? `${label(shown[0])}–${label(shown[1])}` : label(page))}
            onFocus={(e) => {
              setDraft(label(page));
              requestAnimationFrame(() => e.target.select());
            }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commit();
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === 'Escape') {
                setDraft(null);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <span data-testid="page-total">of {n}</span>
        </div>
        <IconButton label={epub && !screen ? 'Next section' : 'Next page'} shortcut={prettyCombo(shortcuts.nextPage)} onClick={() => stepPage(1)} disabled={!canOn} data-testid="next-page">
          <ChevronRight size={17} />
        </IconButton>
        <IconButton label="Last page" shortcut={prettyCombo(shortcuts.lastPage)} onClick={lastPage} disabled={page >= n} className="hidden sm:inline-grid">
          <ChevronsRight size={16} />
        </IconButton>

        {/* Scrubber: a visual progress indicator you can drag */}
        <div className="relative mx-2 flex h-full flex-1 items-center sm:mx-4">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-ink/10">
            <div className="h-full rounded-full bg-accent/70" style={{ width: `${((scrubPage - 1) / Math.max(1, n - 1)) * 100}%` }} />
            {bookmarks.map((b) => (
              <span key={b.id} className="absolute top-1/2 h-2.5 w-[2px] -translate-y-1/2 rounded bg-accent" style={{ left: `${((b.page - 1) / Math.max(1, n - 1)) * 100}%` }} />
            ))}
          </div>
          <input
            type="range"
            min={1}
            max={n}
            value={scrubPage}
            aria-label="Reading progress — drag to move through the document"
            className="relative h-6 w-full cursor-pointer appearance-none bg-transparent opacity-0"
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={() => {
              if (scrub !== null) useReader.getState().nav?.goTo(scrub);
              setScrub(null);
            }}
            onKeyUp={() => {
              if (scrub !== null) useReader.getState().nav?.goTo(scrub);
              setScrub(null);
            }}
          />
          {scrub !== null && (
            <div className="pointer-events-none absolute -top-9 rounded-md bg-ink px-2 py-1 text-[11.5px] text-bg tabular-nums" style={{ left: `calc(${((scrub - 1) / Math.max(1, n - 1)) * 100}% - 20px)` }}>
              {epub ? locShort(doc, scrub) : `p. ${label(scrub)}`}
            </div>
          )}
          <span className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-surface shadow-[0_0_0_1.5px_var(--accent),0_1px_3px_rgb(0_0_0/0.2)]" style={{ left: `calc(${((scrubPage - 1) / Math.max(1, n - 1)) * 100}% - 6px)` }} />
        </div>

        <div className="hidden min-w-[150px] text-right text-[12px] text-ink-3 tabular-nums md:block" data-testid="progress-label">
          {leftInSection ? `${leftInSection} ${leftInSection === 1 ? 'page' : 'pages'} left in section · ` : ''}
          {screen ? `Page ${screen.index + 1}${screen.perView === 2 && screen.index + 2 <= screen.count ? `–${screen.index + 2}` : ''} of ${screen.count} in chapter · ` : ''}
          {pct}%
        </div>
      </footer>
    </>
  );
}
