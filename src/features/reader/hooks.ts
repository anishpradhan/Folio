import { useEffect, useRef } from 'react';
import { useReader } from './store';
import { recordActivity, savePosition } from '../../data/repo';
import { debounce } from '../../lib/util';
import { comboFromEvent, usePrefs, type ShortcutAction } from '../../state/prefs';
import { cycleLayout, firstPage, lastPage, openSearch, stepPage, toggleBookmarkHere, toggleFullscreen, zoom } from './actions';
import { sectionForPage } from '../../core/pdf/indexText';

/** Persist the reading position (page, offset, zoom, layout, view, section) as the reader moves. */
export function usePositionPersistence(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const save = debounce(() => {
      const s = useReader.getState();
      if (!s.doc) return;
      void savePosition(
        s.doc.id,
        {
          page: s.page,
          offset: s.offset,
          zoomMode: s.zoomMode,
          scale: s.scale,
          layout: s.layout,
          view: s.view,
          sectionId: s.sectionId ?? sectionForPage(s.doc.outline, s.page)?.id ?? null,
          savedAt: Date.now(),
        },
        s.doc.pageCount,
      );
    }, 700);
    const unsub = useReader.subscribe((s, p) => {
      if (s.page !== p.page || s.sectionId !== p.sectionId || s.offset !== p.offset || s.scale !== p.scale || s.zoomMode !== p.zoomMode || s.layout !== p.layout || s.view !== p.view) save();
    });
    const flushNow = () => save.flush();
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', flushNow);
    return () => {
      unsub();
      save.flush();
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', flushNow);
    };
  }, [enabled]);
}

/**
 * Track active reading time and pages seen. Time only counts while the tab is visible and the
 * reader has interacted within the last 2 minutes; a page counts as "read" after ~4 s on it.
 */
export function useReadingActivity(docId: string | null) {
  const elapsed = useRef(0);
  useEffect(() => {
    if (!docId) return;
    let lastInput = Date.now();
    let lastTick = Date.now();
    let pending = 0;
    const pages = new Set<number>();
    let pageTimer: ReturnType<typeof setTimeout> | undefined;

    const onInput = () => (lastInput = Date.now());
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, onInput, { passive: true, capture: true }));

    const watchPage = (p: number) => {
      clearTimeout(pageTimer);
      pageTimer = setTimeout(() => pages.add(p), 4000);
    };
    watchPage(useReader.getState().page);
    const unsub = useReader.subscribe((s, prev) => {
      if (s.page !== prev.page) watchPage(s.page);
    });

    const tick = () => {
      const now = Date.now();
      const active = document.visibilityState === 'visible' && now - lastInput < 120_000;
      const dt = Math.min(now - lastTick, 5000);
      if (active) {
        pending += dt;
        elapsed.current += dt;
      }
      lastTick = now;
    };
    const flushActivity = () => {
      tick();
      if (pending > 0 || pages.size) {
        void recordActivity(docId, pending, [...pages]);
        pending = 0;
        pages.clear();
      }
    };
    const t1 = setInterval(tick, 1000);
    const t2 = setInterval(flushActivity, 30_000);
    const onHide = () => document.visibilityState === 'hidden' && flushActivity();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flushActivity);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
      clearTimeout(pageTimer);
      unsub();
      events.forEach((e) => window.removeEventListener(e, onInput, { capture: true }));
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flushActivity);
      flushActivity();
    };
  }, [docId]);
  return elapsed;
}

/** Configurable keyboard shortcuts for the reader. */
export function useReaderShortcuts(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handlers: Record<ShortcutAction, () => void> = {
      nextPage: () => stepPage(1),
      prevPage: () => stepPage(-1),
      firstPage,
      lastPage,
      zoomIn: () => zoom(1),
      zoomOut: () => zoom(-1),
      fitWidth: () => useReader.getState().set({ zoomMode: 'fit-width' }),
      fitPage: () => useReader.getState().set({ zoomMode: 'fit-page' }),
      search: openSearch,
      toggleContents: () => {
        const p = usePrefs.getState();
        p.set({ leftOpen: !p.leftOpen });
      },
      toggleNotebook: () => {
        const p = usePrefs.getState();
        p.set({ rightOpen: !p.rightOpen });
      },
      bookmark: () => void toggleBookmarkHere(),
      focusMode: () => {
        const s = useReader.getState();
        s.set({ focus: !s.focus });
      },
      fullscreen: () => void toggleFullscreen(),
      darkMode: () => usePrefs.getState().toggleDark(),
      cycleLayout,
      reflow: () => {
        const s = useReader.getState();
        s.set({ view: s.view === 'reflow' ? 'original' : 'reflow' });
      },
      preferences: () => {
        const s = useReader.getState();
        s.set({ prefsOpen: !s.prefsOpen });
      },
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (t.closest('[role="dialog"], [role="menu"]') && !['Escape'].includes(e.key)) return;
      const st = useReader.getState();
      if (e.key === 'Escape') {
        if (st.selection || st.activeHighlight || st.dictionary) return; // popovers handle Esc
        if (st.prefsOpen) return st.set({ prefsOpen: false });
        if (st.focus) return st.set({ focus: false });
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      const map = usePrefs.getState().shortcuts;
      const action = (Object.keys(map) as ShortcutAction[]).find((a) => map[a] === combo);
      if (st.doc?.format === 'epub') {
        // Reflowable books: Space/PageDown scroll on through the book, or turn the screen page.
        if (!action && ['Space', 'PageDown', 'PageUp', 'Shift+Space'].includes(combo)) {
          e.preventDefault();
          const dir = combo === 'PageUp' || combo === 'Shift+Space' ? -1 : 1;
          if (st.layout === 'continuous') window.dispatchEvent(new CustomEvent('folio:page-scroll', { detail: dir }));
          else stepPage(dir);
          return;
        }
        // Page geometry and the PDF text view don't apply.
        if (action === 'fitWidth' || action === 'fitPage' || action === 'reflow') return;
      }
      // Space / PageDown / PageUp flip pages in paged views; scroll naturally otherwise.
      if (!action && st.layout !== 'continuous' && st.view === 'original' && ['Space', 'PageDown', 'PageUp', 'Shift+Space'].includes(combo)) {
        e.preventDefault();
        stepPage(combo === 'PageUp' || combo === 'Shift+Space' ? -1 : 1);
        return;
      }
      if (!action && st.view === 'reflow' && ['PageDown', 'PageUp'].includes(combo)) {
        e.preventDefault();
        stepPage(combo === 'PageUp' ? -1 : 1);
        return;
      }
      if (!action) return;
      e.preventDefault();
      handlers[action]();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
