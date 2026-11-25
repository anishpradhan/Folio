import { useEffect, useState, type MutableRefObject } from 'react';
import {
  ArrowLeft,
  PanelLeft,
  PanelRight,
  Search,
  Minus,
  Plus,
  Bookmark,
  Moon,
  Sun,
  Maximize,
  Minimize,
  Glasses,
  ScrollText,
  File,
  BookOpen,
  Type,
  ChevronDown,
  Timer,
  AlignLeft,
  Check,
} from 'lucide-react';
import { useReader, PT_TO_PX, ZOOM_STEPS } from './store';
import { usePrefs, prettyCombo } from '../../state/prefs';
import { navigate } from '../../lib/router';
import { cx } from '../../lib/util';
import { IconButton, Menu, usePopover } from '../../components/ui';
import { openSearch, toggleBookmarkHere, toggleFullscreen, zoom } from './actions';
import { useCurrentSection } from './currentSection';

function useFullscreen() {
  const [fs, setFs] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  return fs;
}

function SessionTimer({ elapsed }: { elapsed: MutableRefObject<number> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor(elapsed.current / 1000);
  const label = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (
    <span className="hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] text-ink-3 tabular-nums sm:inline-flex" data-tip="Active reading time this session" data-testid="reading-timer">
      <Timer size={13} /> {label}
    </span>
  );
}

const Sep = () => <span className="mx-1 hidden h-5 w-px bg-line sm:block" />;

export function Toolbar({ elapsed }: { elapsed: MutableRefObject<number> }) {
  const doc = useReader((s) => s.doc)!;
  const page = useReader((s) => s.page);
  const scale = useReader((s) => s.scale);
  const zoomMode = useReader((s) => s.zoomMode);
  const layout = useReader((s) => s.layout);
  const view = useReader((s) => s.view);
  const focus = useReader((s) => s.focus);
  const bookmarks = useReader((s) => s.bookmarks);
  const set = useReader((s) => s.set);
  const prefsOpen = useReader((s) => s.prefsOpen);
  const { leftOpen, rightOpen, shortcuts, showTimer, appearance } = usePrefs();
  const setPrefs = usePrefs((s) => s.set);
  const toggleDark = usePrefs((s) => s.toggleDark);
  const fs = useFullscreen();
  const zoomMenu = usePopover();
  const layoutMenu = usePopover();
  const [peek, setPeek] = useState(false);

  const section = useCurrentSection(doc, page);
  const epub = doc.format === 'epub';
  const typoSize = usePrefs((s) => s.typography.size);
  const bookmarked = bookmarks.some((b) => b.page === page);
  const k = (a: keyof typeof shortcuts) => prettyCombo(shortcuts[a]);
  const pct = Math.round((scale / PT_TO_PX) * 100);

  // In focus mode the toolbar hides; moving to the top edge reveals it.
  useEffect(() => {
    if (!focus) return setPeek(false);
    const on = (e: PointerEvent) => setPeek(e.clientY < 64);
    window.addEventListener('pointermove', on);
    return () => window.removeEventListener('pointermove', on);
  }, [focus]);

  const LayoutIcon = view === 'reflow' ? AlignLeft : layout === 'continuous' ? ScrollText : layout === 'single' ? File : BookOpen;

  return (
    <header
      className={cx(
        'z-30 flex h-[52px] shrink-0 items-center gap-1 border-b border-line bg-bg/95 px-2 backdrop-blur transition-all duration-300 sm:px-3',
        focus && 'absolute inset-x-0 top-0',
        focus && !peek && 'pointer-events-none -translate-y-full opacity-0',
      )}
      onPointerLeave={() => focus && setPeek(false)}
    >
      <IconButton label="Back to library" onClick={() => navigate('/')}>
        <ArrowLeft size={17} />
      </IconButton>
      <IconButton label="Contents" shortcut={k('toggleContents')} active={leftOpen} onClick={() => setPrefs({ leftOpen: !leftOpen })}>
        <PanelLeft size={17} />
      </IconButton>

      <div className="mx-2 min-w-0 flex-1 sm:mx-3">
        <h1 className="truncate font-display text-[14.5px] leading-tight font-medium" title={doc.title}>
          {doc.title}
        </h1>
        <p className="truncate text-[11.5px] text-ink-3 italic" data-testid="current-section">
          {section?.title ?? doc.author ?? ''}
        </p>
      </div>

      {showTimer && <SessionTimer elapsed={elapsed} />}

      <IconButton label="Search in document" shortcut={k('search')} onClick={openSearch}>
        <Search size={17} />
      </IconButton>
      <Sep />

      {/* Reflowable books: text size instead of zoom */}
      {epub && (
        <div className="hidden items-center md:flex" aria-label="Text size">
          <IconButton label="Smaller text" shortcut={k('zoomOut')} onClick={() => zoom(-1)} disabled={typoSize <= 14}>
            <span className="text-[12px] font-semibold">A</span>
          </IconButton>
          <span className="w-9 text-center text-[12px] text-ink-3 tabular-nums" data-testid="text-size">
            {typoSize}
          </span>
          <IconButton label="Larger text" shortcut={k('zoomIn')} onClick={() => zoom(1)} disabled={typoSize >= 30}>
            <span className="text-[16px] font-semibold">A</span>
          </IconButton>
        </div>
      )}

      {/* Zoom */}
      <div className={cx('hidden items-center md:flex', view === 'reflow' && 'pointer-events-none opacity-35', epub && '!hidden')} aria-label="Zoom">
        <IconButton label="Zoom out" shortcut={k('zoomOut')} onClick={() => zoom(-1)}>
          <Minus size={16} />
        </IconButton>
        <button
          ref={zoomMenu.triggerRef}
          onClick={zoomMenu.toggle}
          className="flex h-8 min-w-[64px] items-center justify-center gap-0.5 rounded-lg px-1.5 text-[12.5px] font-medium text-ink-2 tabular-nums hover:bg-ink/5"
          aria-label="Zoom level"
          data-tip="Zoom & fit"
          data-testid="zoom-level"
        >
          {zoomMode === 'fit-width' ? 'Width' : zoomMode === 'fit-page' ? 'Page' : `${pct}%`}
          <ChevronDown size={12} className="text-ink-3" />
        </button>
        <IconButton label="Zoom in" shortcut={k('zoomIn')} onClick={() => zoom(1)}>
          <Plus size={16} />
        </IconButton>
      </div>
      {zoomMenu.anchor && (
        <Menu
          anchor={zoomMenu.anchor}
          onClose={zoomMenu.close}
          ignore={[zoomMenu.triggerRef.current]}
          align="center"
          items={[
            { label: 'Fit to width', checked: zoomMode === 'fit-width', hint: k('fitWidth'), onSelect: () => set({ zoomMode: 'fit-width' }) },
            { label: 'Fit to page', checked: zoomMode === 'fit-page', hint: k('fitPage'), onSelect: () => set({ zoomMode: 'fit-page' }) },
            'sep',
            ...ZOOM_STEPS.filter((z) => z >= 0.5 * PT_TO_PX && z <= 3 * PT_TO_PX).map((z) => ({
              label: `${Math.round((z / PT_TO_PX) * 100)}%`,
              checked: zoomMode === 'custom' && Math.abs(z - scale) < 0.01,
              onSelect: () => set({ scale: z, zoomMode: 'custom' }),
            })),
          ]}
        />
      )}

      {/* Layout */}
      <button ref={layoutMenu.triggerRef} onClick={layoutMenu.toggle} className="icon-btn !inline-flex w-auto items-center gap-0.5 px-2" aria-label="Page layout" data-tip="Page layout" data-tip-key={k('cycleLayout')}>
        <LayoutIcon size={17} />
        <ChevronDown size={12} className="text-ink-3" />
      </button>
      {layoutMenu.anchor && (
        <Menu
          anchor={layoutMenu.anchor}
          onClose={layoutMenu.close}
          ignore={[layoutMenu.triggerRef.current]}
          title="Layout"
          items={[
            { label: 'Continuous scroll', icon: <ScrollText size={14} />, checked: view === 'original' && layout === 'continuous', onSelect: () => set({ layout: 'continuous', view: 'original' }) },
            { label: 'Single page', icon: <File size={14} />, checked: view === 'original' && layout === 'single', onSelect: () => set({ layout: 'single', view: 'original' }) },
            { label: 'Two-page spread', icon: <BookOpen size={14} />, checked: view === 'original' && layout === 'spread', onSelect: () => set({ layout: 'spread', view: 'original' }) },
            // Books are already reflowable text; the text view is for PDFs.
            ...(epub
              ? []
              : [
                  'sep' as const,
                  { label: 'Text view (reflow)', icon: <AlignLeft size={14} />, checked: view === 'reflow', hint: k('reflow'), onSelect: () => set({ view: view === 'reflow' ? 'original' : 'reflow' }) },
                ]),
          ]}
        />
      )}

      <IconButton label={appearance.invert ? 'Light pages' : 'Dark pages'} shortcut={k('darkMode')} onClick={toggleDark} className="hidden sm:inline-grid">
        {appearance.invert ? <Sun size={17} /> : <Moon size={17} />}
      </IconButton>
      <IconButton label="Reading preferences" shortcut={k('preferences')} active={prefsOpen} onClick={() => set({ prefsOpen: !prefsOpen })} data-testid="open-preferences">
        <Type size={17} />
      </IconButton>
      <Sep />
      <IconButton label={bookmarked ? 'Remove bookmark' : epub ? 'Bookmark this place' : 'Bookmark this page'} shortcut={k('bookmark')} active={bookmarked} onClick={() => void toggleBookmarkHere()} data-testid="bookmark-toggle">
        <Bookmark size={17} fill={bookmarked ? 'currentColor' : 'none'} />
      </IconButton>
      <IconButton label="Distraction-free" shortcut={k('focusMode')} active={focus} onClick={() => set({ focus: !focus })} className="hidden sm:inline-grid">
        <Glasses size={17} />
      </IconButton>
      <IconButton label={fs ? 'Exit full screen' : 'Full screen'} shortcut={k('fullscreen')} onClick={() => void toggleFullscreen()} className="hidden sm:inline-grid">
        {fs ? <Minimize size={16} /> : <Maximize size={16} />}
      </IconButton>
      <IconButton label="Notebook" shortcut={k('toggleNotebook')} active={rightOpen} onClick={() => setPrefs({ rightOpen: !rightOpen })} data-testid="toggle-notebook">
        <PanelRight size={17} />
      </IconButton>
      {focus && (
        <button className="btn btn-ghost ml-1 hidden h-8 text-[12px] sm:inline-flex" onClick={() => set({ focus: false })}>
          <Check size={14} /> Done
        </button>
      )}
    </header>
  );
}
