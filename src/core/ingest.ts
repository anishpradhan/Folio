import { sniffFormat, FORMATS } from './formats';
import type { DocumentRecord } from './types';
import { sha256Hex } from '../lib/sha256';
import { findDocumentByHash } from '../data/repo';
import { IngestError, type ProgressFn } from './ingestCommon';

export { IngestError } from './ingestCommon';
export type { IngestStage, ProgressFn } from './ingestCommon';

const MAX_BYTES = 600 * 1024 * 1024;

/**
 * Ingest a user file: validate, detect the real format, de-duplicate by content hash, then hand
 * off to the format's ingester. The original bytes are stored untouched.
 */
export async function ingestFile(file: File, onProgress: ProgressFn = () => {}): Promise<{ doc: DocumentRecord; duplicate: boolean }> {
  if (file.size === 0) throw new IngestError('empty', 'This file is empty.');
  if (file.size > MAX_BYTES) throw new IngestError('too-large', 'This file is larger than 600 MB.');

  onProgress('reading', 0);
  const format = await sniffFormat(file);
  if (!format) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const what = ext ? `.${ext} files aren't supported.` : "This file type isn't supported.";
    throw new IngestError('unsupported', `${what} Folio reads PDF and EPUB books.`);
  }
  if (!FORMATS[format].supported) throw new IngestError('not-yet-supported', `${FORMATS[format].label} files aren't supported yet.`);

  const buf = await file.arrayBuffer();
  const hash = await sha256Hex(buf);
  const existing = await findDocumentByHash(hash);
  if (existing) return { doc: existing, duplicate: true };

  // Each format's code (pdf.js for PDF, the zip reader for EPUB) loads only when needed.
  const doc =
    format === 'epub'
      ? await (await import('./epub/ingest')).ingestEpub(file, buf, hash, onProgress)
      : await (await import('./pdf/ingest')).ingestPdf(file, buf, hash, onProgress);
  return { doc, duplicate: false };
}
