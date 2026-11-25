import type { DocFormat, DocumentRecord } from './types';
import { uid } from '../lib/util';

export type IngestErrorKind = 'unsupported' | 'not-yet-supported' | 'encrypted' | 'corrupt' | 'empty' | 'too-large';

export class IngestError extends Error {
  constructor(
    public kind: IngestErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export type IngestStage = 'reading' | 'parsing' | 'measuring' | 'cover' | 'saving';
export type ProgressFn = (stage: IngestStage, fraction: number) => void;

/** Shared fields of a freshly ingested document. */
export function newRecord(fields: Pick<DocumentRecord, 'title' | 'pageCount' | 'pageSizes' | 'outline' | 'cover'> & Partial<DocumentRecord> & { format: DocFormat; file: File; hash: string }): DocumentRecord {
  const { file, hash, ...rest } = fields;
  const now = Date.now();
  return {
    id: uid(),
    fileName: file.name,
    fileSize: file.size,
    fileHash: hash,
    mimeType: rest.format === 'epub' ? 'application/epub+zip' : 'application/pdf',
    author: '',
    subject: '',
    keywords: '',
    creator: '',
    producer: '',
    createdDate: null,
    pageLabels: null,
    addedAt: now,
    updatedAt: now,
    lastOpenedAt: null,
    favorite: false,
    collectionIds: [],
    currentPage: 1,
    furthestPage: 0,
    completedAt: null,
    position: null,
    index: { status: 'pending', pagesIndexed: 0 },
    deletedAt: null,
    ...rest,
  };
}

/** Render an image (blob URL / data URL) to a JPEG cover of the given width. */
export async function imageToCover(src: string, width = 440): Promise<{ cover: string; size: [number, number] } | null> {
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    await img.decode();
    const w = img.naturalWidth || 600,
      h = img.naturalHeight || 900;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round((h / w) * width);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { cover: canvas.toDataURL('image/jpeg', 0.84), size: [w, h] };
  } catch {
    return null;
  }
}
