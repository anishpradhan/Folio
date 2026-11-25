import { create } from 'zustand';
import * as api from './api';
import { usePrefs } from '../state/prefs';
import { getFileBlob } from '../data/repo';
import type { DocumentRecord } from '../core/types';
import type { AiDocument, AnswerCitation, AnswerSource, AskBody, AskMode, ConversationSummary, Health, MessageStatus, StoredMessage } from './api';

/** A message as the chat shows it: stored ones, plus the one being streamed. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  mode: AskMode;
  citations: AnswerCitation[];
  /** Live answers only: the passages the answer was given. */
  sources?: AnswerSource[];
  status: MessageStatus | 'streaming';
  thinking?: boolean;
  error?: string;
  retryable?: boolean;
  /** For a failed answer: what was asked, so it can be asked again. */
  request?: AskBody;
  selection?: string;
  selectionPage?: number | null;
}

export type HealthState = { kind: 'checking' } | { kind: 'offline' } | { kind: 'online'; health: Health };
/** `missing`: the backend has never seen this file. */
export type DocState = { kind: 'loading' } | { kind: 'missing' } | { kind: 'uploading' } | { kind: 'known'; doc: AiDocument } | { kind: 'error'; message: string };

interface AiState {
  health: HealthState;
  docs: Record<string, DocState>;
  conversations: Record<string, ConversationSummary[] | undefined>;
  /** Open conversation per document (null = a new, not yet created conversation). */
  active: Record<string, string | null | undefined>;
  messages: Record<string, ChatMessage[] | undefined>;
  suggestions: Record<string, string[] | null | undefined>;
  streaming: { conversationId: string; abort: AbortController } | null;
}

export const useAi = create<AiState>(() => ({
  health: { kind: 'checking' },
  docs: {},
  conversations: {},
  active: {},
  messages: {},
  suggestions: {},
  streaming: null,
}));

const set = useAi.setState;
const get = useAi.getState;
const patchDoc = (hash: string, s: DocState) => set((st) => ({ docs: { ...st.docs, [hash]: s } }));
const patchMessages = (cid: string, f: (m: ChatMessage[]) => ChatMessage[]) => set((st) => ({ messages: { ...st.messages, [cid]: f(st.messages[cid] ?? []) } }));
const updateLast = (cid: string, f: (m: ChatMessage) => ChatMessage) => patchMessages(cid, (ms) => (ms.length ? [...ms.slice(0, -1), f(ms[ms.length - 1])] : ms));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ------------------------------ backend + document ------------------------------ */

export async function checkHealth() {
  try {
    set({ health: { kind: 'online', health: await api.getHealth() } });
  } catch {
    set({ health: { kind: 'offline' } });
  }
}

const watchers = new Map<string, () => void>();

function watch(hash: string) {
  if (watchers.has(hash)) return;
  const stop = api.watchDocument(
    hash,
    (doc) => {
      patchDoc(hash, { kind: 'known', doc });
      if (api.settled(doc)) {
        watchers.get(hash)?.();
        watchers.delete(hash);
      }
    },
    () => {
      watchers.delete(hash);
      // The stream dropped (backend restarted?): fall back to one fresh read.
      void loadDocument(hash);
    },
  );
  watchers.set(hash, stop);
}

export async function loadDocument(hash: string) {
  const cur = get().docs[hash];
  if (!cur) patchDoc(hash, { kind: 'loading' });
  try {
    const doc = await api.getAiDocument(hash);
    patchDoc(hash, doc ? { kind: 'known', doc } : { kind: 'missing' });
    if (doc && !api.settled(doc)) watch(hash);
  } catch (e) {
    patchDoc(hash, { kind: 'error', message: message(e) });
  }
}

/** Send the file's bytes (from the reader's own storage) to the backend and follow its preparation. */
export async function prepareDocument(hash: string, file: Blob, title: string, fileName: string) {
  patchDoc(hash, { kind: 'uploading' });
  try {
    const doc = await api.uploadDocument(file, hash, title, fileName);
    patchDoc(hash, { kind: 'known', doc });
    if (!api.settled(doc)) watch(hash);
  } catch (e) {
    patchDoc(hash, { kind: 'error', message: message(e) });
  }
}

/**
 * Prepare a PDF in the background without being asked: after it's added to the library, and when one that
 * the backend has never seen is opened. Does nothing when the preference is off, the backend isn't running,
 * or the backend already knows the file (prepared, preparing or failed: a failure is retried by hand).
 */
export async function autoPrepare(doc: DocumentRecord, file?: Blob) {
  if (doc.format !== 'pdf' || !usePrefs.getState().aiAutoPrepare || autoPreparing.has(doc.fileHash)) return;
  autoPreparing.add(doc.fileHash);
  try {
    if (get().health.kind !== 'online') await checkHealth();
    if (get().health.kind !== 'online') return;
    const cur = get().docs[doc.fileHash];
    if (cur?.kind === 'known' || cur?.kind === 'uploading') return; // known to the backend, or on its way
    let known: api.AiDocument | null;
    try {
      known = await api.getAiDocument(doc.fileHash);
    } catch {
      return; // the Ask tab reports backend errors when it's opened
    }
    if (known) {
      patchDoc(doc.fileHash, { kind: 'known', doc: known });
      if (!api.settled(known)) watch(doc.fileHash);
      return;
    }
    const blob = file ?? (await getFileBlob(doc.id));
    if (blob) await prepareDocument(doc.fileHash, blob, doc.title, doc.fileName);
  } finally {
    autoPreparing.delete(doc.fileHash);
  }
}
const autoPreparing = new Set<string>();

export async function retryPreparation(hash: string) {
  try {
    const doc = await api.retryDocument(hash);
    patchDoc(hash, { kind: 'known', doc });
    watch(hash);
  } catch (e) {
    patchDoc(hash, { kind: 'error', message: message(e) });
  }
}

/* ------------------------------ conversations ------------------------------ */

const fromStored = (m: StoredMessage): ChatMessage => ({
  id: m.id,
  role: m.role,
  content: m.content,
  mode: m.mode,
  citations: m.citations ?? [],
  status: m.status,
  selection: m.scope?.selection?.text,
  selectionPage: m.scope?.selection?.page ?? null,
});

export async function loadConversations(hash: string, { openLatest = false } = {}) {
  const list = await api.listConversations(hash);
  set((st) => ({ conversations: { ...st.conversations, [hash]: list } }));
  if (openLatest && get().active[hash] === undefined) {
    if (list[0]) await openConversation(hash, list[0].id);
    else set((st) => ({ active: { ...st.active, [hash]: null } }));
  }
}

export async function openConversation(hash: string, id: string | null) {
  set((st) => ({ active: { ...st.active, [hash]: id } }));
  if (!id || get().streaming?.conversationId === id) return;
  const conv = await api.getConversation(id);
  set((st) => ({ messages: { ...st.messages, [id]: conv.messages.map(fromStored) } }));
}

export async function removeConversation(hash: string, id: string) {
  if (get().streaming?.conversationId === id) stopAnswer();
  await api.deleteConversation(id);
  set((st) => {
    const { [id]: _, ...rest } = st.messages;
    return { messages: rest, active: { ...st.active, [hash]: st.active[hash] === id ? null : st.active[hash] } };
  });
  await loadConversations(hash);
}

export async function loadSuggestions(hash: string) {
  if (get().suggestions[hash] !== undefined) return;
  set((st) => ({ suggestions: { ...st.suggestions, [hash]: null } }));
  try {
    const { questions } = await api.getSuggestions(hash);
    set((st) => ({ suggestions: { ...st.suggestions, [hash]: questions } }));
  } catch {
    set((st) => ({ suggestions: { ...st.suggestions, [hash]: [] } })); // nice to have; never an error state
  }
}

/* ------------------------------ asking ------------------------------ */

/**
 * Ask a question (or run a selection mode) and stream the answer.
 *
 * By default it goes to the document's open conversation, creating one if needed. The selection assistant
 * passes `conversation`: an id to continue its own conversation, or `'new'` for a fresh one that doesn't
 * become the Ask tab's open conversation (`onConversation` reports its id before the answer streams).
 */
export async function askQuestion(hash: string, body: AskBody, opts: { conversation?: string | 'new'; onConversation?: (id: string) => void } = {}) {
  if (get().streaming) return;
  let cid = opts.conversation === 'new' ? null : (opts.conversation ?? get().active[hash] ?? null);
  const abort = new AbortController();
  try {
    if (!cid) {
      const conv = await api.createConversation(hash);
      cid = conv.id;
      const makeActive = opts.conversation !== 'new';
      set((st) => ({ active: makeActive ? { ...st.active, [hash]: conv.id } : st.active, messages: { ...st.messages, [conv.id]: [] } }));
    }
  } catch (e) {
    throw new Error(message(e));
  }
  const conversationId = cid;
  opts.onConversation?.(conversationId);
  set({ streaming: { conversationId, abort } });
  patchMessages(conversationId, (ms) => [
    ...ms,
    { id: `pending-q-${Date.now()}`, role: 'user', content: body.content || modeLabel(body.mode), mode: body.mode ?? 'chat', citations: [], status: 'complete', selection: body.selection?.text, selectionPage: body.selection?.page ?? null },
    { id: `pending-a-${Date.now()}`, role: 'assistant', content: '', mode: body.mode ?? 'chat', citations: [], status: 'streaming', request: body },
  ]);
  try {
    await api.ask(
      conversationId,
      body,
      (ev) => {
        switch (ev.event) {
          case 'start':
            patchMessages(conversationId, (ms) => ms.map((m, i) => (i === ms.length - 2 ? { ...m, id: ev.data.userMessageId } : m)));
            break;
          case 'sources':
            updateLast(conversationId, (m) => ({ ...m, sources: ev.data }));
            break;
          case 'status':
            updateLast(conversationId, (m) => ({ ...m, thinking: true }));
            break;
          case 'delta':
            updateLast(conversationId, (m) => ({ ...m, thinking: false, content: m.content + ev.data.text }));
            break;
          case 'citation':
            updateLast(conversationId, (m) => ({ ...m, citations: [...m.citations, ev.data] }));
            break;
          case 'done':
            updateLast(conversationId, (m) => ({ ...m, id: ev.data.messageId, status: ev.data.status, thinking: false }));
            break;
          case 'error':
            updateLast(conversationId, (m) => ({
              ...m,
              id: ev.data.messageId ?? m.id,
              status: /declined/i.test(ev.data.message) ? 'refused' : 'error',
              content: /declined/i.test(ev.data.message) ? '' : m.content,
              thinking: false,
              error: ev.data.message,
              retryable: ev.data.retryable,
            }));
            break;
        }
      },
      abort.signal,
    );
  } catch (e) {
    if (abort.signal.aborted) updateLast(conversationId, (m) => ({ ...m, status: 'interrupted', thinking: false }));
    else updateLast(conversationId, (m) => ({ ...m, status: 'error', thinking: false, error: message(e), retryable: true }));
  } finally {
    // A stream that ended without `done`/`error` (connection dropped) is not left spinning.
    updateLast(conversationId, (m) => (m.status === 'streaming' ? { ...m, status: 'interrupted', thinking: false } : m));
    set({ streaming: null });
    void loadConversations(hash);
  }
}

export function stopAnswer() {
  get().streaming?.abort.abort();
}

export function modeLabel(mode: AskMode | undefined) {
  return { explain: 'Explain this passage', summarize: 'Summarize this passage', simplify: 'Simplify this passage', ask: 'Question', chat: 'Question' }[mode ?? 'chat'];
}
