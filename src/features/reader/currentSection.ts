import { useMemo } from 'react';
import { useReader } from './store';
import { flattenOutline, sectionForPage } from '../../core/outline';
import type { DocumentRecord, OutlineNode } from '../../core/types';

/**
 * The contents entry the reader is in. PDFs: by page. EPUBs: by scroll position within the
 * section, tracked by EpubView (several contents entries can live in one section).
 */
export function useCurrentSection(doc: Pick<DocumentRecord, 'outline' | 'format'>, page: number): OutlineNode | null {
  const epubSectionId = useReader((s) => s.sectionId);
  return useMemo(() => {
    if (doc.format === 'epub' && epubSectionId) {
      const hit = flattenOutline(doc.outline).find((f) => f.node.id === epubSectionId);
      if (hit) return hit.node;
    }
    return sectionForPage(doc.outline, page);
  }, [doc.outline, doc.format, page, epubSectionId]);
}

/**
 * For EPUB: the last contents entry in `page` whose heading the reader has reached. `reached`
 * decides per heading element (above the reading line when scrolling; on or before the visible
 * screen page when paginated).
 */
export function activeEntry(outline: OutlineNode[], page: number, resolve: (anchor: string) => Element | null, reached: (el: Element) => boolean): string | null {
  const here = flattenOutline(outline).filter((f) => f.node.page === page);
  if (!here.length) return null;
  let active: OutlineNode | null = null;
  for (const { node } of here) {
    if (!node.anchor) {
      active ??= node;
      continue;
    }
    const el = resolve(node.anchor);
    if (el && reached(el)) active = node;
  }
  return (active ?? here[0].node).id;
}
