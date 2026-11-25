import type { PDFDocumentProxy } from './pdfjs';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import { buildPageText, type TextItemLike } from '../text/structure';

/** Per-document cache of pdf.js text content, shared by text layers, reflow view and live search. */
const caches = new WeakMap<PDFDocumentProxy, Map<number, Promise<TextContent>>>();

export function getTextContent(pdf: PDFDocumentProxy, pageNum: number): Promise<TextContent> {
  let m = caches.get(pdf);
  if (!m) caches.set(pdf, (m = new Map()));
  let p = m.get(pageNum);
  if (!p) {
    p = pdf.getPage(pageNum).then((page) => page.getTextContent());
    m.set(pageNum, p);
    p.catch(() => m!.delete(pageNum));
  }
  return p;
}

export async function getPageTextLive(pdf: PDFDocumentProxy, pageNum: number): Promise<string> {
  const content = await getTextContent(pdf, pageNum);
  return buildPageText(content.items as TextItemLike[]);
}
