import type { DocumentRecord } from '../core/types';
import { flattenOutline, sectionForPage } from '../core/outline';

/**
 * Human labels for a location. PDFs have pages ("p. 12"); EPUBs have sections, labelled by their
 * chapter title from the table of contents when there is one ("Chapter Two: Weather").
 */
type Doc = Pick<DocumentRecord, 'format' | 'pageLabels' | 'outline'>;

export const isReflowable = (doc?: Pick<DocumentRecord, 'format'> | null) => doc?.format === 'epub';

/**
 * A section-level label: the first contents entry that starts in this section (its chapter
 * heading, not a later sub-heading), else the chapter it falls inside.
 */
export function epubTitle(doc: Pick<DocumentRecord, 'outline'>, page: number) {
  const first = flattenOutline(doc.outline).find((f) => f.node.page === page);
  return first?.node.title ?? sectionForPage(doc.outline, page)?.title ?? null;
}

/** "Page 12" / "Chapter Two: Weather" */
export function locLong(doc: Doc | undefined | null, page: number): string {
  if (!doc) return `Page ${page}`;
  if (isReflowable(doc)) return epubTitle(doc, page) ?? `Section ${page}`;
  return `Page ${doc.pageLabels?.[page - 1] ?? page}`;
}

/** "p. 12" / "Chapter Two: Weather" */
export function locShort(doc: Doc | undefined | null, page: number): string {
  if (!doc) return `p. ${page}`;
  if (isReflowable(doc)) return epubTitle(doc, page) ?? `§ ${page}`;
  return `p. ${doc.pageLabels?.[page - 1] ?? page}`;
}

/** "page" / "section" — for sentences like "Bookmark this page". */
export const unitWord = (doc: Pick<DocumentRecord, 'format'> | undefined | null) => (isReflowable(doc) ? 'section' : 'page');
