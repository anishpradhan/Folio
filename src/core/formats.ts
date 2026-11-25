import type { DocFormat } from './types';

/**
 * Format registry. Ingestion and the reader look formats up here, so adding EPUB later means
 * implementing an ingester + a renderer and flipping `supported` — no changes to the library.
 */
export interface FormatInfo {
  format: DocFormat;
  label: string;
  extensions: string[];
  mimeTypes: string[];
  supported: boolean;
  /** Fixed-layout formats keep the original page design; reflowable ones honour typography settings. */
  layout: 'fixed' | 'reflowable';
}

export const FORMATS: Record<DocFormat, FormatInfo> = {
  pdf: { format: 'pdf', label: 'PDF', extensions: ['pdf'], mimeTypes: ['application/pdf'], supported: true, layout: 'fixed' },
  epub: { format: 'epub', label: 'EPUB', extensions: ['epub'], mimeTypes: ['application/epub+zip'], supported: true, layout: 'reflowable' },
};

export const ACCEPT_ATTR = Object.values(FORMATS)
  .flatMap((f) => [...f.extensions.map((e) => `.${e}`), ...f.mimeTypes])
  .join(',');

/** Sniff the real format from magic bytes (extensions lie). */
export async function sniffFormat(file: Blob & { name?: string }): Promise<DocFormat | null> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const ascii = String.fromCharCode(...head);
  if (ascii.includes('%PDF-')) return 'pdf';
  const zip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  // Spec-compliant EPUBs start with an uncompressed "mimetype" entry; some tools skip that, so a
  // zip named .epub is accepted too (the parser then validates its container and package).
  if (zip && (ascii.includes('mimetypeapplication/epub+zip') || /\.epub$/i.test(file.name ?? ''))) return 'epub';
  return null;
}
