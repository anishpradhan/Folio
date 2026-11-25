import { create } from 'zustand';
import type { IngestStage } from '../core/ingestCommon';
import type { DocumentRecord } from '../core/types';
import { flash } from '../components/ui';
import { navigate, readerPath } from '../lib/router';
import { formatBytes, uid } from '../lib/util';
import { updateDocument } from '../data/repo';

export interface Upload {
  id: string;
  name: string;
  stage: IngestStage | 'queued' | 'downloading' | 'error';
  fraction: number;
  /** Extra status, e.g. "1.2 MB of 3.4 MB". */
  detail?: string;
  error?: string;
  /** Links only: the link, so a failed import can be retried. */
  link?: string;
}

const STAGE_LABEL: Record<Upload['stage'], string> = {
  queued: 'Waiting…',
  downloading: 'Downloading…',
  reading: 'Reading file…',
  parsing: 'Opening document…',
  measuring: 'Measuring pages…',
  cover: 'Setting the cover…',
  saving: 'Placing on your shelf…',
  error: 'Could not add',
};
export const stageLabel = (s: Upload['stage']) => STAGE_LABEL[s];

type Opts = { collectionId?: string };

interface UploadState {
  items: Upload[];
  add: (files: File[], opts?: Opts) => Promise<void>;
  /** Download a document from a link (PDF/EPUB, paper page, DOI, arXiv id) and add it. */
  addLink: (link: string, opts?: Opts) => Promise<void>;
  /** Dismiss a failed item, or cancel a download in progress. */
  dismiss: (id: string) => void;
}

let chain = Promise.resolve();
const downloads = new Map<string, AbortController>();

const linkLabel = (link: string) => {
  try {
    const u = new URL(link);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : decodeURI(u.pathname)}${u.search}`;
  } catch {
    return link;
  }
};

export const useUploads = create<UploadState>((set, get) => {
  const patch = (id: string, p: Partial<Upload>) => set({ items: get().items.map((u) => (u.id === id ? { ...u, ...p } : u)) });

  /** Ingest one file (serialised so large files don't compete for memory). */
  const ingest = (u: Upload, file: File, opts: Opts | undefined, single: boolean, after?: (doc: DocumentRecord, duplicate: boolean) => Promise<DocumentRecord>) => {
    chain = chain.then(async () => {
      // pdf.js is loaded on demand so the library's first paint stays light.
      const { ingestFile, IngestError } = await import('../core/ingest');
      try {
        let { doc, duplicate } = await ingestFile(file, (stage, fraction) => patch(u.id, { stage, fraction, detail: undefined }));
        if (after) doc = await after(doc, duplicate);
        if (opts?.collectionId && !['favorites'].includes(opts.collectionId) && !doc.collectionIds.includes(opts.collectionId))
          await updateDocument(doc.id, { collectionIds: [...doc.collectionIds, opts.collectionId] });
        if (opts?.collectionId === 'favorites') await updateDocument(doc.id, { favorite: true });
        get().dismiss(u.id);
        // Have the assistant read new PDFs right away, in the background (no-op if it isn't running).
        void import('../ai/store').then((m) => m.autoPrepare(doc, file)).catch(() => undefined);
        if (duplicate) flash(`“${doc.title}” is already on your shelf`, { label: 'Open', run: () => navigate(readerPath(doc.id)) });
        else if (single) flash(`Added “${doc.title}”`, { label: 'Read now', run: () => navigate(readerPath(doc.id)) }, 4000);
      } catch (e) {
        patch(u.id, { stage: 'error', detail: undefined, error: e instanceof IngestError ? e.message : 'Something went wrong while adding this file.' });
        if (!(e instanceof IngestError)) console.error(e);
      }
    });
    return chain;
  };

  return {
    items: [],
    dismiss: (id) => {
      downloads.get(id)?.abort();
      downloads.delete(id);
      set({ items: get().items.filter((u) => u.id !== id) });
    },
    add: async (files, opts) => {
      const fresh = files.map((f) => ({ file: f, u: { id: uid(), name: f.name, stage: 'queued', fraction: 0 } as Upload }));
      set({ items: [...get().items, ...fresh.map((x) => x.u)] });
      for (const { file, u } of fresh) void ingest(u, file, opts, fresh.length === 1);
      await chain;
    },
    addLink: async (link, opts) => {
      const { fetchLink, normalizeLink, LinkError } = await import('../core/linkImport');
      const href = normalizeLink(link) ?? link;
      const u: Upload = { id: uid(), name: linkLabel(href), stage: 'downloading', fraction: 0, link };
      set({ items: [...get().items.filter((x) => !(x.stage === 'error' && x.link === link)), u] });
      const ctrl = new AbortController();
      downloads.set(u.id, ctrl);
      let got: Awaited<ReturnType<typeof fetchLink>>;
      try {
        got = await fetchLink(
          link,
          (loaded, total) => patch(u.id, { fraction: total ? loaded / total : 0, detail: total ? `${formatBytes(loaded)} of ${formatBytes(total)}` : formatBytes(loaded) }),
          ctrl.signal,
        );
      } catch (e) {
        if (ctrl.signal.aborted) return;
        patch(u.id, { stage: 'error', detail: undefined, error: e instanceof LinkError ? e.message : 'Couldn’t download from that link.' });
        if (!(e instanceof LinkError)) console.error(e);
        return;
      } finally {
        downloads.delete(u.id);
      }
      if (!get().items.some((x) => x.id === u.id)) return; // cancelled
      patch(u.id, { name: got.file.name, stage: 'queued', fraction: 0, detail: undefined });
      await ingest(u, got.file, opts, true, async (doc, duplicate) => {
        if (duplicate) return doc;
        // A paper's landing page names it more reliably than PDF metadata ("80721234",
        // "pone.0000001 1..11") or a file name like "2301.01234".
        const fields: Partial<DocumentRecord> = { sourceUrl: got.source };
        if (got.meta.title) fields.title = got.meta.title;
        if (got.meta.authors?.length) fields.author = formatAuthors(got.meta.authors);
        await updateDocument(doc.id, fields);
        return { ...doc, ...fields };
      });
    },
  };
});

/** "Last, First" → "First Last"; long lists become "A, B et al." */
function formatAuthors(list: string[]): string {
  const names = list.map((n) => (/^[^,]+,\s*[^,]+$/.test(n) ? n.split(/,\s*/).reverse().join(' ') : n).trim());
  return names.length > 3 ? `${names.slice(0, 2).join(', ')} et al.` : names.join(', ');
}
