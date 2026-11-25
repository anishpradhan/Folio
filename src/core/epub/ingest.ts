import { parseEpub, readFile, mediaTypeOf, EpubError } from './epub';
import { sectionElement } from './book';
import { htmlText } from '../text/domText';
import { sectionForPage } from '../outline';
import { IngestError, imageToCover, newRecord, type ProgressFn } from '../ingestCommon';
import { addDocument, putPageTexts } from '../../data/repo';
import { titleFromFileName } from '../../lib/util';
import type { DocumentRecord, PageTextRecord } from '../types';

/**
 * EPUB ingestion: package metadata, table of contents, cover, and the text of every section
 * (indexed immediately — HTML text extraction is cheap). Each spine item is one "page" in Folio's
 * location model, so highlights, bookmarks, search and progress all work unchanged.
 */
export async function ingestEpub(file: File, buf: ArrayBuffer, hash: string, onProgress: ProgressFn): Promise<DocumentRecord> {
  onProgress('parsing', 0.1);
  let pkg;
  try {
    pkg = parseEpub(new Uint8Array(buf));
  } catch (e) {
    if (e instanceof EpubError) throw new IngestError(e.kind === 'drm' ? 'encrypted' : e.kind === 'empty' ? 'empty' : 'corrupt', e.message);
    throw new IngestError('corrupt', "This EPUB couldn't be opened — it may be damaged.");
  }

  // Cover: declared cover image, else the first image of the first section (common for cover pages).
  onProgress('cover', 0.3);
  let coverPath = pkg.coverPath;
  if (!coverPath) {
    const first = sectionElement(pkg, 1, (p) => p);
    coverPath = first.querySelector('img')?.getAttribute('src') ?? null;
  }
  let cover: string | null = null;
  let size: [number, number] = [600, 900];
  const coverBytes = coverPath ? readFile(pkg.files, coverPath) : undefined;
  if (coverPath && coverBytes) {
    const url = URL.createObjectURL(new Blob([coverBytes], { type: mediaTypeOf(pkg, coverPath) }));
    const rendered = await imageToCover(url);
    URL.revokeObjectURL(url);
    if (rendered) {
      cover = rendered.cover;
      size = rendered.size;
    }
  }

  onProgress('measuring', 0.45);
  const doc = newRecord({
    format: 'epub',
    file,
    hash,
    title: pkg.metadata.title || titleFromFileName(file.name),
    author: pkg.metadata.creator,
    subject: pkg.metadata.subject || pkg.metadata.description.slice(0, 280),
    keywords: [pkg.metadata.publisher, pkg.metadata.language].filter(Boolean).join(' · '),
    creator: pkg.metadata.publisher,
    createdDate: pkg.metadata.date && !isNaN(Date.parse(pkg.metadata.date)) ? new Date(pkg.metadata.date).toISOString() : null,
    pageCount: pkg.spine.length,
    // Reflowable: no page geometry. The cover's proportions drive the shelf thumbnail.
    pageSizes: [size],
    outline: pkg.toc,
    cover,
    index: { status: 'indexing', pagesIndexed: 0 },
  });

  // Section text — the same source search, Insights and future Q&A use for PDFs.
  const pages: PageTextRecord[] = [];
  for (let i = 1; i <= pkg.spine.length; i++) {
    const text = htmlText(sectionElement(pkg, i, () => null));
    const section = sectionForPage(pkg.toc, i);
    pages.push({ id: `${doc.id}:${i}`, docId: doc.id, page: i, text, sectionId: section?.id ?? null, sectionTitle: section?.title ?? null });
    if (i % 10 === 0) {
      onProgress('measuring', 0.45 + (i / pkg.spine.length) * 0.4);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  onProgress('saving', 0.9);
  const ready: DocumentRecord = { ...doc, index: { status: 'ready', pagesIndexed: pkg.spine.length } };
  await addDocument(ready, new Blob([buf], { type: 'application/epub+zip' }));
  await putPageTexts(pages);
  onProgress('saving', 1);
  return ready;
}
