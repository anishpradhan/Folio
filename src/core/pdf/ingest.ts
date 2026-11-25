import { loadPdf, isPasswordError, type PDFDocumentProxy } from './pdfjs';
import type { DocumentRecord, OutlineNode } from '../types';
import { titleFromFileName, uid } from '../../lib/util';
import { addDocument } from '../../data/repo';
import { IngestError, newRecord, type ProgressFn } from '../ingestCommon';
import { scheduleIndexing } from './indexText';

/** "D:20230514101500+02'00'" → ISO string */
function parsePdfDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return isNaN(date.getTime()) ? null : date.toISOString();
}

const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim() : '');

async function resolveOutline(pdf: PDFDocumentProxy): Promise<OutlineNode[]> {
  const raw = await pdf.getOutline().catch(() => null);
  if (!raw?.length) return [];
  type RawItem = { title: string; dest: unknown; items?: RawItem[] };
  const walk = async (items: RawItem[]): Promise<OutlineNode[]> => {
    const out: OutlineNode[] = [];
    for (const it of items) {
      let page: number | null = null;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0] != null) {
          const ref = dest[0];
          page = typeof ref === 'number' ? ref + 1 : (await pdf.getPageIndex(ref)) + 1;
        }
      } catch {
        page = null;
      }
      out.push({ id: uid(), title: clean(it.title) || 'Untitled section', page, children: it.items?.length ? await walk(it.items) : [] });
    }
    return out;
  };
  return walk(raw as RawItem[]);
}

async function renderCover(pdf: PDFDocumentProxy, width = 440): Promise<string | null> {
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    return canvas.toDataURL('image/jpeg', 0.84);
  } catch {
    return null;
  }
}

async function measurePages(pdf: PDFDocumentProxy, onProgress: (f: number) => void): Promise<[number, number][]> {
  const n = pdf.numPages;
  const sizes: [number, number][] = new Array(n);
  const BATCH = 24;
  for (let start = 1; start <= n; start += BATCH) {
    const nums = Array.from({ length: Math.min(BATCH, n - start + 1) }, (_, i) => start + i);
    await Promise.all(
      nums.map(async (num) => {
        const p = await pdf.getPage(num);
        const v = p.getViewport({ scale: 1 });
        sizes[num - 1] = [Math.round(v.width * 100) / 100, Math.round(v.height * 100) / 100];
      }),
    );
    onProgress(Math.min(1, (start + BATCH - 1) / n));
  }
  return sizes;
}

/** PDF ingestion: metadata, outline, page geometry and cover; full text is indexed in the background. */
export async function ingestPdf(file: File, buf: ArrayBuffer, hash: string, onProgress: ProgressFn): Promise<DocumentRecord> {
  onProgress('parsing', 0.1);
  let pdf: PDFDocumentProxy;
  try {
    pdf = await loadPdf(buf.slice(0));
  } catch (e) {
    if (isPasswordError(e)) throw new IngestError('encrypted', 'This PDF is password-protected. Remove the password and try again.');
    throw new IngestError('corrupt', "This PDF couldn't be opened — it may be damaged or incomplete.");
  }

  try {
    if (pdf.numPages < 1) throw new IngestError('empty', 'This PDF has no pages.');
    const meta = await pdf.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const xmp = meta?.metadata;
    const outline = await resolveOutline(pdf);
    const labels = await pdf.getPageLabels().catch(() => null);
    const pageLabels = labels && labels.some((l, i) => l && l !== String(i + 1)) ? labels : null;

    onProgress('measuring', 0.2);
    const pageSizes = await measurePages(pdf, (f) => onProgress('measuring', 0.2 + f * 0.6));

    onProgress('cover', 0.82);
    const cover = await renderCover(pdf);

    const title = clean(xmp?.get('dc:title')) || clean(info.Title);
    const doc = newRecord({
      format: 'pdf',
      file,
      hash,
      // Many PDFs carry junk titles like "Microsoft Word - draft.docx"; prefer the filename then.
      title: title && !/^(untitled|microsoft word|document\d*$)/i.test(title) ? title : titleFromFileName(file.name),
      author: clean(xmp?.get('dc:creator')) || clean(info.Author),
      subject: clean(info.Subject),
      keywords: clean(info.Keywords),
      creator: clean(info.Creator),
      producer: clean(info.Producer),
      createdDate: parsePdfDate(info.CreationDate),
      pageCount: pdf.numPages,
      pageSizes,
      pageLabels,
      outline,
      cover,
    });

    onProgress('saving', 0.92);
    await addDocument(doc, new Blob([buf], { type: 'application/pdf' }));
    onProgress('saving', 1);
    scheduleIndexing(doc.id);
    return doc;
  } finally {
    pdf.destroy();
  }
}
