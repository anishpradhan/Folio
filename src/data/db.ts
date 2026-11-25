import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  Bookmark,
  Collection,
  DocumentRecord,
  Goal,
  Highlight,
  JournalEntry,
  PageNote,
  PageTextRecord,
  ReadingDay,
  VocabularyEntry,
} from '../core/types';

export interface FileRecord {
  id: string;
  blob: Blob;
}

interface FolioDB extends DBSchema {
  documents: { key: string; value: DocumentRecord; indexes: { byHash: string } };
  files: { key: string; value: FileRecord };
  pages: { key: string; value: PageTextRecord; indexes: { byDoc: string } };
  highlights: { key: string; value: Highlight; indexes: { byDoc: string } };
  bookmarks: { key: string; value: Bookmark; indexes: { byDoc: string } };
  notes: { key: string; value: PageNote; indexes: { byDoc: string } };
  vocabulary: { key: string; value: VocabularyEntry; indexes: { byKey: string } };
  journal: { key: string; value: JournalEntry; indexes: { byDoc: string } };
  collections: { key: string; value: Collection };
  days: { key: string; value: ReadingDay };
  goals: { key: string; value: Goal };
}

export type StoreName =
  | 'documents'
  | 'files'
  | 'pages'
  | 'highlights'
  | 'bookmarks'
  | 'notes'
  | 'vocabulary'
  | 'journal'
  | 'collections'
  | 'days'
  | 'goals';

const DB_NAME = 'folio';
/**
 * v1 — initial schema.
 * Document Q&A keeps its passages, vectors and chats in the backend (backend/), not here.
 */
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<FolioDB>> | null = null;

export function db(): Promise<IDBPDatabase<FolioDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FolioDB>(DB_NAME, DB_VERSION, {
      upgrade(d) {
        const docs = d.createObjectStore('documents', { keyPath: 'id' });
        docs.createIndex('byHash', 'fileHash');
        d.createObjectStore('files', { keyPath: 'id' });
        d.createObjectStore('pages', { keyPath: 'id' }).createIndex('byDoc', 'docId');
        d.createObjectStore('highlights', { keyPath: 'id' }).createIndex('byDoc', 'docId');
        d.createObjectStore('bookmarks', { keyPath: 'id' }).createIndex('byDoc', 'docId');
        d.createObjectStore('notes', { keyPath: 'id' }).createIndex('byDoc', 'docId');
        d.createObjectStore('vocabulary', { keyPath: 'id' }).createIndex('byKey', 'key');
        d.createObjectStore('journal', { keyPath: 'id' }).createIndex('byDoc', 'docId');
        d.createObjectStore('collections', { keyPath: 'id' });
        d.createObjectStore('days', { keyPath: 'date' });
        d.createObjectStore('goals', { keyPath: 'id' });
      },
      blocking() {
        // Another tab wants to upgrade — release our connection.
        dbPromise?.then((x) => x.close());
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}

/* ------------------------------------------------------------------ *
 * Change notification: a tiny live-query mechanism. Every write calls
 * `notify(stores)`; hooks subscribed to those stores re-run their query.
 * Changes are also broadcast to other open tabs.
 * ------------------------------------------------------------------ */

type Listener = (stores: Set<StoreName>) => void;
const listeners = new Set<Listener>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('folio-db') : null;

channel?.addEventListener('message', (e) => {
  const stores = new Set<StoreName>(e.data as StoreName[]);
  listeners.forEach((l) => l(stores));
});

export function notify(...stores: StoreName[]) {
  const set = new Set(stores);
  listeners.forEach((l) => l(set));
  channel?.postMessage(stores);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
