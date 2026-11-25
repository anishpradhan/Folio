/**
 * Folio's domain model.
 *
 * Layering (kept deliberately separate):
 *  - core/        document *processing*: formats, ingestion, text extraction, search primitives.
 *  - data/        persistence (IndexedDB) and live queries.
 *  - features/    reading UI, annotations, library, insights…
 *  - ai/          client for the document Q&A backend (backend/, docs/ai/architecture.md).
 *
 * Anything that identifies a location in a document uses (docId, page) with 1-based pages,
 * so highlights, bookmarks, extracted text, and future RAG chunks can all cite the same place.
 */

export type DocFormat = 'pdf' | 'epub';

export interface OutlineNode {
  id: string;
  title: string;
  /** 1-based page number (EPUB: spine section), or null when the destination could not be resolved. */
  page: number | null;
  /** Element id within the page/section (EPUB fragment), when the entry points mid-section. */
  anchor?: string;
  children: OutlineNode[];
}

export type IndexStatus = 'pending' | 'indexing' | 'ready' | 'error';

export type ZoomMode = 'fit-width' | 'fit-page' | 'custom';
export type LayoutMode = 'continuous' | 'single' | 'spread';
export type ViewMode = 'original' | 'reflow';

/** Everything needed to put the reader back exactly where it was. */
export interface ReadingPosition {
  page: number;
  /** Fraction (0..1) of the page height scrolled past the page's top edge. */
  offset: number;
  zoomMode: ZoomMode;
  scale: number;
  layout: LayoutMode;
  view: ViewMode;
  /** Outline node id of the active section when saved (informational; recomputed on load). */
  sectionId: string | null;
  savedAt: number;
}

export interface DocumentRecord {
  id: string;
  format: DocFormat;
  fileName: string;
  fileSize: number;
  /** SHA-256 of the original bytes — used for duplicate detection and as a stable content id. */
  fileHash: string;
  mimeType: string;

  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  /** ISO date string from the PDF info dictionary, if present. */
  createdDate: string | null;

  pageCount: number;
  /** Unscaled page sizes in PDF points, [width, height], index 0 = page 1. */
  pageSizes: [number, number][];
  /** Custom page labels (e.g. "iv", "A-3") if the PDF defines them. */
  pageLabels: string[] | null;
  outline: OutlineNode[];
  /** JPEG data URL rendered from page 1. */
  cover: string | null;

  addedAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  favorite: boolean;
  collectionIds: string[];

  /** Last page the reader was on. */
  currentPage: number;
  /** Furthest page reached — reading progress is derived from this. */
  furthestPage: number;
  completedAt: number | null;
  position: ReadingPosition | null;

  /** State of full-text extraction (used by search, reflow view and the future RAG pipeline). */
  index: { status: IndexStatus; pagesIndexed: number; error?: string };

  /** Soft-delete marker: set while an "undo" window is open; purged afterwards. */
  deletedAt: number | null;

  /** The web link the document was added from, if it came from one. */
  sourceUrl?: string;
}

/** Extracted text of one page. The canonical text source for search, reflow and future chunking. */
export interface PageTextRecord {
  /** `${docId}:${page}` */
  id: string;
  docId: string;
  page: number;
  /**
   * Text in reading order. Items on a line are concatenated as in the PDF, line ends are "\n",
   * paragraph breaks (large vertical gaps) are "\n\n".
   */
  text: string;
  /** Deepest outline section containing this page, if the document has an outline. */
  sectionId: string | null;
  sectionTitle: string | null;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';

/** Rectangle in page space, normalised to 0..1 of the page's width/height (zoom independent). */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Highlight {
  id: string;
  docId: string;
  page: number;
  color: HighlightColor;
  text: string;
  /** Empty when created in reflow view; resolved to geometry the next time the page renders. */
  rects: NormRect[];
  /**
   * Position in the section's folded text (see core/text/search.ts). Used by reflowable formats
   * (EPUB), where there is no page geometry, to tell repeated phrases apart.
   */
  anchor?: { start: number; end: number };
  note: string;
  important: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Bookmark {
  id: string;
  docId: string;
  page: number;
  /** Scroll fraction within the section (reflowable formats). */
  offset?: number;
  title: string;
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface PageNote {
  id: string;
  docId: string;
  page: number;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface DictionaryMeaning {
  partOfSpeech: string;
  definitions: { definition: string; example?: string }[];
  synonyms: string[];
}

export interface DictionaryEntry {
  word: string;
  phonetic: string | null;
  audioUrl: string | null;
  meanings: DictionaryMeaning[];
  sourceName: string;
  sourceUrl: string | null;
}

export interface VocabularyEntry extends DictionaryEntry {
  id: string;
  /** Lower-cased headword; one entry per word. */
  key: string;
  docId: string | null;
  page: number | null;
  /** Sentence the word was found in. */
  context: string;
  learned: boolean;
  createdAt: number;
  updatedAt: number;
}

export type JournalKind = 'thoughts' | 'summary' | 'takeaways' | 'reflection';

export interface JournalEntry {
  id: string;
  docId: string | null;
  kind: JournalKind;
  title: string;
  body: string;
  /** YYYY-MM-DD */
  date: string;
  page: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Collection {
  id: string;
  name: string;
  createdAt: number;
}

/** Aggregated reading activity per calendar day (local time). */
export interface ReadingDay {
  /** YYYY-MM-DD */
  date: string;
  ms: number;
  /** Distinct pages viewed per document on that day. */
  pages: Record<string, number[]>;
}

export type GoalKind = 'pages-daily' | 'minutes-daily' | 'finish-doc';

export interface Goal {
  id: string;
  kind: GoalKind;
  target: number;
  docId: string | null;
  /** YYYY-MM-DD for finish-doc goals. */
  deadline: string | null;
  createdAt: number;
}
