import { db, notify } from './db';
import { dayKey, uid } from '../lib/util';
import type {
  Bookmark,
  Collection,
  DocumentRecord,
  Goal,
  Highlight,
  HighlightColor,
  JournalEntry,
  NormRect,
  PageNote,
  PageTextRecord,
  ReadingDay,
  ReadingPosition,
  VocabularyEntry,
  DictionaryEntry,
  JournalKind,
  GoalKind,
} from '../core/types';

/**
 * Read-modify-write inside one readwrite transaction. IndexedDB serialises overlapping readwrite
 * transactions on a store, so concurrent patches (e.g. a note autosave and a colour change fired
 * by the same click) can't overwrite each other.
 */
async function patchRecord<S extends 'highlights' | 'bookmarks' | 'notes' | 'vocabulary' | 'collections'>(
  store: S,
  id: string,
  fn: (cur: NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof db>>['get']>>>) => object,
) {
  const d = await db();
  const tx = d.transaction(store, 'readwrite');
  const cur = await tx.store.get(id);
  if (cur) await tx.store.put({ ...cur, ...fn(cur as never) } as never);
  await tx.done;
  if (cur) notify(store);
}

/* ============================== Documents ============================== */

export async function listDocuments(): Promise<DocumentRecord[]> {
  const all = await (await db()).getAll('documents');
  return all.filter((d) => !d.deletedAt);
}

export async function getDocument(id: string) {
  return (await db()).get('documents', id);
}

export async function findDocumentByHash(hash: string) {
  const list = await (await db()).getAllFromIndex('documents', 'byHash', hash);
  return list.find((d) => !d.deletedAt);
}

export async function getFileBlob(id: string): Promise<Blob | undefined> {
  return (await (await db()).get('files', id))?.blob;
}

export async function addDocument(doc: DocumentRecord, blob: Blob) {
  const d = await db();
  const tx = d.transaction(['documents', 'files'], 'readwrite');
  await Promise.all([tx.objectStore('documents').put(doc), tx.objectStore('files').put({ id: doc.id, blob }), tx.done]);
  notify('documents');
}

export async function updateDocument(id: string, patch: Partial<DocumentRecord> | ((d: DocumentRecord) => Partial<DocumentRecord>)) {
  const d = await db();
  const tx = d.transaction('documents', 'readwrite');
  const cur = await tx.store.get(id);
  if (!cur) return;
  const p = typeof patch === 'function' ? patch(cur) : patch;
  await tx.store.put({ ...cur, ...p, updatedAt: Date.now() });
  await tx.done;
  notify('documents');
}

/*
 * The last position is also mirrored to localStorage synchronously: an IndexedDB write started as
 * the page unloads (reload, closing the tab) may never commit, and losing your place is the worst
 * thing a reader can do.
 */
const posKey = (id: string) => `folio:pos:${id}`;

/** The newer of the stored position and its synchronous mirror. */
export function latestPosition(id: string, stored: ReadingPosition | null | undefined): ReadingPosition | null {
  let mirror: ReadingPosition | null = null;
  try {
    const raw = localStorage.getItem(posKey(id));
    if (raw) mirror = JSON.parse(raw) as ReadingPosition;
  } catch {
    /* storage unavailable */
  }
  if (!mirror || typeof mirror.page !== 'number') return stored ?? null;
  return !stored || (mirror.savedAt ?? 0) > (stored.savedAt ?? 0) ? mirror : stored;
}

export async function savePosition(id: string, pos: ReadingPosition, pageCount: number) {
  try {
    localStorage.setItem(posKey(id), JSON.stringify(pos));
  } catch {
    /* storage unavailable or full: IndexedDB still has it */
  }
  await updateDocument(id, (cur) => {
    const furthest = Math.max(cur.furthestPage || 0, pos.page);
    return {
      position: pos,
      currentPage: pos.page,
      furthestPage: furthest,
      completedAt: cur.completedAt ?? (furthest >= pageCount ? Date.now() : null),
    };
  });
}

export const softDeleteDocument = (id: string) => updateDocument(id, { deletedAt: Date.now() });
export const restoreDocument = (id: string) => updateDocument(id, { deletedAt: null });

/** Permanently remove a document and everything attached to it. */
export async function purgeDocument(id: string) {
  try {
    localStorage.removeItem(posKey(id));
  } catch {
    /* ignore */
  }
  const d = await db();
  const stores = ['documents', 'files', 'pages', 'highlights', 'bookmarks', 'notes', 'journal'] as const;
  const tx = d.transaction([...stores], 'readwrite');
  await tx.objectStore('documents').delete(id);
  await tx.objectStore('files').delete(id);
  for (const s of ['pages', 'highlights', 'bookmarks', 'notes', 'journal'] as const) {
    const store = tx.objectStore(s);
    const keys = await store.index('byDoc').getAllKeys(id);
    await Promise.all(keys.map((k) => store.delete(k)));
  }
  await tx.done;
  notify(...stores);
}

/** Purge documents whose undo window expired (e.g. the tab was closed mid-undo). */
export async function purgeExpiredDeletes(olderThanMs = 10_000) {
  const all = await (await db()).getAll('documents');
  const now = Date.now();
  for (const doc of all) if (doc.deletedAt && now - doc.deletedAt > olderThanMs) await purgeDocument(doc.id);
}

/* ============================== Page text ============================== */

export async function putPageTexts(records: PageTextRecord[]) {
  const d = await db();
  const tx = d.transaction('pages', 'readwrite');
  await Promise.all([...records.map((r) => tx.store.put(r)), tx.done]);
  notify('pages');
}

export async function getPageTexts(docId: string): Promise<PageTextRecord[]> {
  const list = await (await db()).getAllFromIndex('pages', 'byDoc', docId);
  return list.sort((a, b) => a.page - b.page);
}

export async function getPageText(docId: string, page: number) {
  return (await db()).get('pages', `${docId}:${page}`);
}

/* ============================== Highlights ============================== */

export async function listHighlights(docId?: string): Promise<Highlight[]> {
  const d = await db();
  return docId ? d.getAllFromIndex('highlights', 'byDoc', docId) : d.getAll('highlights');
}

export async function addHighlight(input: { docId: string; page: number; color: HighlightColor; text: string; rects: NormRect[]; note?: string; anchor?: { start: number; end: number } }) {
  const now = Date.now();
  const h: Highlight = { id: uid(), important: false, createdAt: now, updatedAt: now, ...input, note: input.note ?? '' };
  await (await db()).put('highlights', h);
  notify('highlights');
  return h;
}

export async function updateHighlight(id: string, patch: Partial<Highlight>) {
  await patchRecord('highlights', id, () => ({ ...patch, updatedAt: Date.now() }));
}

export async function deleteHighlight(id: string) {
  await (await db()).delete('highlights', id);
  notify('highlights');
}

export async function restoreHighlight(h: Highlight) {
  await (await db()).put('highlights', h);
  notify('highlights');
}

/* ============================== Bookmarks ============================== */

export async function listBookmarks(docId?: string): Promise<Bookmark[]> {
  const d = await db();
  const list = docId ? await d.getAllFromIndex('bookmarks', 'byDoc', docId) : await d.getAll('bookmarks');
  return list.sort((a, b) => a.page - b.page);
}

export async function addBookmark(docId: string, page: number, title = '', offset?: number) {
  const now = Date.now();
  const b: Bookmark = { id: uid(), docId, page, title, note: '', createdAt: now, updatedAt: now, ...(offset !== undefined ? { offset } : {}) };
  await (await db()).put('bookmarks', b);
  notify('bookmarks');
  return b;
}

export async function updateBookmark(id: string, patch: Partial<Bookmark>) {
  await patchRecord('bookmarks', id, () => ({ ...patch, updatedAt: Date.now() }));
}

export async function deleteBookmark(id: string) {
  await (await db()).delete('bookmarks', id);
  notify('bookmarks');
}

/** Toggle the bookmark on a page; returns the new bookmark or null if removed. */
export async function toggleBookmark(docId: string, page: number, offset?: number): Promise<Bookmark | null> {
  const existing = (await listBookmarks(docId)).find((b) => b.page === page);
  if (existing) {
    await deleteBookmark(existing.id);
    return null;
  }
  return addBookmark(docId, page, '', offset);
}

/* ============================== Page notes ============================== */

export async function listNotes(docId?: string): Promise<PageNote[]> {
  const d = await db();
  return docId ? d.getAllFromIndex('notes', 'byDoc', docId) : d.getAll('notes');
}

export async function addNote(docId: string, page: number, body: string) {
  const now = Date.now();
  const n: PageNote = { id: uid(), docId, page, body, createdAt: now, updatedAt: now };
  await (await db()).put('notes', n);
  notify('notes');
  return n;
}

export async function updateNote(id: string, body: string) {
  await patchRecord('notes', id, () => ({ body, updatedAt: Date.now() }));
}

export async function deleteNote(id: string) {
  await (await db()).delete('notes', id);
  notify('notes');
}

/* ============================== Vocabulary ============================== */

export async function listVocabulary(): Promise<VocabularyEntry[]> {
  const list = await (await db()).getAll('vocabulary');
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export async function findVocabulary(word: string) {
  return (await (await db()).getAllFromIndex('vocabulary', 'byKey', word.toLowerCase()))[0];
}

export async function saveVocabulary(entry: DictionaryEntry, ctx: { docId: string | null; page: number | null; context: string }) {
  const existing = await findVocabulary(entry.word);
  const now = Date.now();
  const v: VocabularyEntry = existing
    ? { ...existing, ...entry, updatedAt: now }
    : { ...entry, ...ctx, id: uid(), key: entry.word.toLowerCase(), learned: false, createdAt: now, updatedAt: now };
  await (await db()).put('vocabulary', v);
  notify('vocabulary');
  return v;
}

export async function updateVocabulary(id: string, patch: Partial<VocabularyEntry>) {
  await patchRecord('vocabulary', id, () => ({ ...patch, updatedAt: Date.now() }));
}

export async function deleteVocabulary(id: string) {
  await (await db()).delete('vocabulary', id);
  notify('vocabulary');
}

/* ============================== Journal ============================== */

export async function listJournal(): Promise<JournalEntry[]> {
  const list = await (await db()).getAll('journal');
  return list.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1));
}

export async function saveJournal(entry: Partial<JournalEntry> & { kind: JournalKind }) {
  const now = Date.now();
  const d = await db();
  const cur = entry.id ? await d.get('journal', entry.id) : undefined;
  const e: JournalEntry = {
    id: uid(),
    docId: null,
    title: '',
    body: '',
    date: dayKey(),
    page: null,
    createdAt: now,
    ...cur,
    ...entry,
    updatedAt: now,
  } as JournalEntry;
  await d.put('journal', e);
  notify('journal');
  return e;
}

export async function deleteJournal(id: string) {
  await (await db()).delete('journal', id);
  notify('journal');
}

/* ============================== Collections ============================== */

export async function listCollections(): Promise<Collection[]> {
  const list = await (await db()).getAll('collections');
  return list.sort((a, b) => a.createdAt - b.createdAt);
}

export async function addCollection(name: string) {
  const c: Collection = { id: uid(), name: name.trim(), createdAt: Date.now() };
  await (await db()).put('collections', c);
  notify('collections');
  return c;
}

export async function renameCollection(id: string, name: string) {
  await patchRecord('collections', id, () => ({ name: name.trim() }));
}

export async function deleteCollection(id: string) {
  const d = await db();
  const tx = d.transaction(['collections', 'documents'], 'readwrite');
  await tx.objectStore('collections').delete(id);
  const docs = await tx.objectStore('documents').getAll();
  for (const doc of docs)
    if (doc.collectionIds.includes(id))
      await tx.objectStore('documents').put({ ...doc, collectionIds: doc.collectionIds.filter((c) => c !== id) });
  await tx.done;
  notify('collections', 'documents');
}

/* ============================== Reading activity ============================== */

export async function listDays(): Promise<ReadingDay[]> {
  const list = await (await db()).getAll('days');
  return list.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Add active reading time and viewed pages to today's activity record. */
export async function recordActivity(docId: string, ms: number, pages: number[]) {
  if (ms <= 0 && pages.length === 0) return;
  const d = await db();
  const date = dayKey();
  const tx = d.transaction('days', 'readwrite');
  const cur: ReadingDay = (await tx.store.get(date)) ?? { date, ms: 0, pages: {} };
  const set = new Set(cur.pages[docId] ?? []);
  pages.forEach((p) => set.add(p));
  await tx.store.put({ ...cur, ms: cur.ms + Math.max(0, ms), pages: { ...cur.pages, [docId]: [...set].sort((a, b) => a - b) } });
  await tx.done;
  notify('days');
}

/* ============================== Goals ============================== */

export async function listGoals(): Promise<Goal[]> {
  const list = await (await db()).getAll('goals');
  return list.sort((a, b) => a.createdAt - b.createdAt);
}

export async function addGoal(kind: GoalKind, target: number, docId: string | null = null, deadline: string | null = null) {
  const g: Goal = { id: uid(), kind, target, docId, deadline, createdAt: Date.now() };
  await (await db()).put('goals', g);
  notify('goals');
  return g;
}

export async function deleteGoal(id: string) {
  await (await db()).delete('goals', id);
  notify('goals');
}
