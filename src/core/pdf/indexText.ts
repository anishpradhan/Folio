import { loadPdf } from './pdfjs';
import { buildPageText, type TextItemLike } from '../text/structure';
import { getDocument, getFileBlob, listDocuments, putPageTexts, updateDocument } from '../../data/repo';
import type { PageTextRecord } from '../types';
import { sectionForPage } from '../outline';

/**
 * Background full-text extraction. Produces one PageTextRecord per page — the shared text source
 * for search, reflow reading, and (later) chunking + embeddings for document Q&A.
 */

const queue: string[] = [];
let running = false;

export function scheduleIndexing(docId: string) {
  if (!queue.includes(docId)) queue.push(docId);
  void pump();
}

/** On startup: resume any extraction interrupted by a reload. */
export async function resumePendingIndexing() {
  const docs = await listDocuments();
  docs.filter((d) => d.index.status !== 'ready' && d.index.status !== 'error').forEach((d) => scheduleIndexing(d.id));
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      try {
        await indexDocument(id);
      } catch (e) {
        console.error('[folio] indexing failed', e);
        await updateDocument(id, (d) => ({ index: { ...d.index, status: 'error', error: String(e) } }));
      }
    }
  } finally {
    running = false;
  }
}

export { flattenOutline, sectionForPage } from '../outline';

async function indexDocument(docId: string) {
  const doc = await getDocument(docId);
  if (!doc || doc.deletedAt || doc.index.status === 'ready' || doc.format !== 'pdf') return;
  const blob = await getFileBlob(docId);
  if (!blob) throw new Error('File missing');

  await updateDocument(docId, { index: { status: 'indexing', pagesIndexed: 0 } });
  const pdf = await loadPdf(await blob.arrayBuffer());
  try {
    const BATCH = 16;
    let batch: PageTextRecord[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const text = buildPageText(content.items as TextItemLike[]);
      const section = sectionForPage(doc.outline, p);
      batch.push({ id: `${docId}:${p}`, docId, page: p, text, sectionId: section?.id ?? null, sectionTitle: section?.title ?? null });
      page.cleanup();
      if (batch.length >= BATCH || p === pdf.numPages) {
        await putPageTexts(batch);
        batch = [];
        // Stop if the document was deleted meanwhile.
        const still = await getDocument(docId);
        if (!still || still.deletedAt) return;
        await updateDocument(docId, { index: { status: p === pdf.numPages ? 'ready' : 'indexing', pagesIndexed: p } });
        // Yield to keep the UI responsive.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    pdf.destroy();
  }
}
