import { create } from 'zustand';
import type { PDFDocumentProxy } from '../../core/pdf/pdfjs';
import type { EpubBook } from '../../core/epub/book';
import type { Bookmark, DocumentRecord, Highlight, LayoutMode, NormRect, PageNote, ViewMode, ZoomMode } from '../../core/types';
import type { SearchHit } from '../../core/text/search';

export interface GoToOptions {
  /** Normalised y (0..1) within the page to bring to the reading line. */
  y?: number;
  /** Fraction offset used when restoring a saved position. */
  offset?: number;
  smooth?: boolean;
  /** Element id inside the section to scroll to (EPUB table-of-contents fragments, links). */
  anchor?: string;
}

/** Imperative navigation API registered by the active view (continuous / paged / reflow). */
export interface Navigator {
  goTo: (page: number, opts?: GoToOptions) => void;
  /** Turn one screen page (paginated reflowable books); falls back to whole pages when absent. */
  step?: (dir: 1 | -1) => void;
}

/** Paginated EPUB: which screen page of the current section is showing. */
export interface ScreenPage {
  /** First visible column (0-based). */
  index: number;
  count: number;
  /** Columns shown at once: 1 (single page) or 2 (spread). */
  perView: number;
}

/** One page's slice of a text selection (selections can span pages). */
export interface SelectionPart {
  page: number;
  text: string;
  rects: NormRect[];
  /** Folded-text position within a reflowable section (EPUB). */
  anchor?: { start: number; end: number };
}

export interface SelectionInfo {
  text: string;
  parts: SelectionPart[];
  anchor: DOMRect;
  /** Sentence around the selection — dictionary context, saved with vocabulary. */
  context: string;
  /** True when made in the reflow text view (no geometry available). */
  reflow: boolean;
}

export interface DictionaryRequest {
  term: string;
  anchor: DOMRect;
  page: number;
  context: string;
}

/** A cited passage shown briefly on the page after clicking a citation in an answer. */
export interface CitationFlash {
  /** Changes on every click, so clicking the same citation again flashes it again. */
  key: number;
  /** Verbatim text from the document; matched in the page's text layer for exact rectangles. */
  quote: string;
  /** Fallback rectangles (the cited paragraphs' boxes), per page. */
  locations: { page: number; rect: NormRect }[];
}

/** The selection assistant's card: the selected text it works on, and where to show the card. */
export interface AiCardRequest {
  text: string;
  page: number;
  anchor: DOMRect;
  /** The selection per page, so an answer can be saved as a highlight of it. */
  parts: SelectionPart[];
}

export type Composer =
  | { kind: 'passage'; highlightId: string; anchor: DOMRect }
  | { kind: 'page'; page: number }
  | { kind: 'bookmark'; bookmarkId: string };

interface ReaderState {
  doc: DocumentRecord | null;
  pdf: PDFDocumentProxy | null;
  /** The opened EPUB, for reflowable books (pdf is null then). */
  book: EpubBook | null;
  page: number;
  /** EPUB: the contents entry at the reading line (null → derive from page). */
  sectionId: string | null;
  offset: number;
  screen: ScreenPage | null;
  scale: number;
  zoomMode: ZoomMode;
  layout: LayoutMode;
  view: ViewMode;
  focus: boolean;
  prefsOpen: boolean;

  highlights: Highlight[];
  bookmarks: Bookmark[];
  notes: PageNote[];

  searchQuery: string;
  searchHits: SearchHit[];
  searchActive: number;
  searchStatus: 'idle' | 'searching' | 'done';
  /** When set, the page view scrolls the given match into view once its text layer is ready. */
  pendingMatch: { page: number; indexOnPage: number } | null;

  selection: SelectionInfo | null;
  activeHighlight: { id: string; anchor: DOMRect; focusNote?: boolean } | null;
  dictionary: DictionaryRequest | null;
  aiCard: AiCardRequest | null;
  composer: Composer | null;
  flashHighlight: string | null;
  citationFlash: CitationFlash | null;

  nav: Navigator | null;
  set: (patch: Partial<ReaderState> | ((s: ReaderState) => Partial<ReaderState>)) => void;
  reset: () => void;
}

const initial = {
  doc: null,
  pdf: null,
  book: null,
  page: 1,
  sectionId: null,
  offset: 0,
  screen: null,
  scale: 1,
  zoomMode: 'fit-width' as ZoomMode,
  layout: 'continuous' as LayoutMode,
  view: 'original' as ViewMode,
  focus: false,
  prefsOpen: false,
  highlights: [],
  bookmarks: [],
  notes: [],
  searchQuery: '',
  searchHits: [],
  searchActive: -1,
  searchStatus: 'idle' as const,
  pendingMatch: null,
  selection: null,
  activeHighlight: null,
  dictionary: null,
  aiCard: null,
  composer: null,
  flashHighlight: null,
  citationFlash: null,
  nav: null,
};

export const useReader = create<ReaderState>((set) => ({
  ...initial,
  set: (patch) => set(patch),
  reset: () => set(initial),
}));

export const goTo = (page: number, opts?: GoToOptions) => useReader.getState().nav?.goTo(page, opts);

/** Close every transient popover (selection toolbar, highlight card, dictionary). */
export const closePopovers = () => useReader.getState().set({ selection: null, activeHighlight: null, dictionary: null });

/** Zoom steps expressed as CSS px per PDF point (1.333 = 100% physical size). */
export const PT_TO_PX = 96 / 72;
export const ZOOM_STEPS = [0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5].map((z) => z * PT_TO_PX);
export const MIN_SCALE = ZOOM_STEPS[0];
export const MAX_SCALE = ZOOM_STEPS[ZOOM_STEPS.length - 1];

export function nextZoom(scale: number, dir: 1 | -1) {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > scale * 1.01) ?? MAX_SCALE;
  return [...ZOOM_STEPS].reverse().find((z) => z < scale * 0.99) ?? MIN_SCALE;
}

/** Pages shown together in spread mode: cover alone, then pairs (2–3, 4–5, …), like a printed book. */
export function spreadOf(page: number, count: number): number[] {
  if (page <= 1) return [1];
  const left = page % 2 === 0 ? page : page - 1;
  return left + 1 <= count ? [left, left + 1] : [left];
}
