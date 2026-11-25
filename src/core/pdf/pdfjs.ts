import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';

const BASE = import.meta.env.BASE_URL;

/** Load a PDF from bytes. The buffer is transferred to the worker, so pass a copy if you need it later. */
export function loadPdf(data: ArrayBuffer | Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({
    data,
    password,
    isEvalSupported: false,
    // Copied from pdfjs-dist by scripts/copy-pdfjs-assets.mjs: needed for CJK text and non-embedded fonts.
    cMapUrl: `${BASE}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`,
  }).promise;
}

export function isPasswordError(e: unknown) {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'PasswordException';
}
