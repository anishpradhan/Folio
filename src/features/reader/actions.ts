import { useReader, spreadOf, nextZoom, closePopovers } from './store';
import { addHighlight, deleteHighlight, restoreHighlight, toggleBookmark } from '../../data/repo';
import type { Highlight, HighlightColor } from '../../core/types';
import { flash } from '../../components/ui';
import { usePrefs } from '../../state/prefs';
import { clamp } from '../../lib/util';
import { isReflowable, locLong, unitWord } from '../../lib/locations';

/** Reader commands, shared by toolbar buttons, keyboard shortcuts and popovers. */

export function stepPage(dir: 1 | -1) {
  const st = useReader.getState();
  const n = st.doc?.pageCount ?? 1;
  if (st.nav?.step) return st.nav.step(dir);
  if (st.view === 'original' && st.layout === 'spread') {
    const cur = spreadOf(st.page, n);
    const next = dir > 0 ? cur[cur.length - 1] + 1 : cur[0] - 1;
    if (next >= 1 && next <= n) st.nav?.goTo(next);
    return;
  }
  const next = st.page + dir;
  if (next >= 1 && next <= n) st.nav?.goTo(next);
}

export const firstPage = () => useReader.getState().nav?.goTo(1);
export const lastPage = () => {
  const st = useReader.getState();
  st.nav?.goTo(st.doc?.pageCount ?? 1);
};

export function zoom(dir: 1 | -1) {
  const st = useReader.getState();
  // Reflowable books have no page to zoom: change the text size instead.
  if (isReflowable(st.doc)) {
    const p = usePrefs.getState();
    p.setTypography({ size: clamp(p.typography.size + dir, 14, 30) });
    return;
  }
  if (st.view === 'reflow') return;
  st.set({ scale: nextZoom(st.scale, dir), zoomMode: 'custom' });
}

export async function toggleBookmarkHere(page?: number) {
  const st = useReader.getState();
  if (!st.doc) return;
  const p = page ?? st.page;
  // In reflowable books a bookmark also remembers how far into the section you were.
  const b = await toggleBookmark(st.doc.id, p, isReflowable(st.doc) && page === undefined ? st.offset : undefined);
  const where = locLong(st.doc, p);
  flash(b ? `Bookmarked · ${where}` : `Bookmark removed · ${where}`);
}

export async function highlightSelection(color: HighlightColor, opts: { openNote?: boolean } = {}) {
  const st = useReader.getState();
  const sel = st.selection;
  if (!sel || !st.doc) return;
  const created: Highlight[] = [];
  for (const part of sel.parts) created.push(await addHighlight({ docId: st.doc.id, page: part.page, color, text: part.text, rects: part.rects, anchor: part.anchor }));
  window.getSelection()?.removeAllRanges();
  closePopovers();
  if (opts.openNote && created[0]) st.set({ activeHighlight: { id: created[0].id, anchor: sel.anchor, focusNote: true } });
  else flash(created.length > 1 ? `Highlighted across ${created.length} ${unitWord(st.doc)}s` : 'Highlighted');
  return created;
}

export async function removeHighlight(h: Highlight) {
  await deleteHighlight(h.id);
  closePopovers();
  flash('Highlight removed', { label: 'Undo', run: () => void restoreHighlight(h) });
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  flash('Copied to clipboard');
}

/** Open the contents sidebar on its Search tab and focus the field. */
export function openSearch() {
  usePrefs.getState().set({ leftOpen: true, leftTab: 'search' });
  useReader.getState().set({ focus: false });
  requestAnimationFrame(() => window.dispatchEvent(new Event('folio:focus-search')));
}

export async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    flash('Full screen is not available here');
  }
}

export function cycleLayout() {
  const st = useReader.getState();
  const order = ['continuous', 'single', 'spread'] as const;
  const next = order[(order.indexOf(st.layout) + 1) % order.length];
  st.set({ layout: next, view: 'original' });
  flash(next === 'continuous' ? 'Continuous scroll' : next === 'single' ? 'Single page' : 'Two-page spread');
}
