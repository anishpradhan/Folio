/**
 * Typed client for the Folio AI backend (backend/, FastAPI). The browser only ever talks to `/api/ai/*` on
 * its own origin; Vite proxies that to the backend on 127.0.0.1, so API keys never reach the browser.
 */

const BASE = '/api/ai';

/* ------------------------------- types ------------------------------- */

export interface Health {
  ok: boolean;
  embedding: { provider: string; model: string };
  llm: { provider: string; model: string; configured: boolean };
  worker: boolean;
  pipelineVersion: number;
}

export type DocStage = 'queued' | 'parsing' | 'chunking' | 'embedding' | 'indexing' | 'ready' | 'failed';

export interface AiDocument {
  id: string;
  title: string;
  pageCount: number | null;
  status: DocStage;
  progress: number;
  detail: string | null;
  error: string | null;
  chunkCount: number;
  /** 'quick': passages from the PDF's text layer, answering while the layout is read; 'full': from the layout reader. */
  index: 'quick' | 'full' | null;
  /** Ready from the quick pass while the full pass runs or waits (backend `is_refining`). */
  refining: boolean;
  job?: { status: string; stage: string | null; attempt: number; error: string | null; errorKind: string | null };
}

/** A normalised (0..1, top-left origin) rectangle on a page, as stored for highlights. */
export interface CitationLocation {
  page: number;
  rect: { x: number; y: number; w: number; h: number };
}

export interface AnswerCitation {
  id: number;
  /** 1-based source number within the answer's context. */
  source: number;
  chunkId: string | null;
  page: number;
  locations: CitationLocation[];
  /** Verbatim text from the document. */
  quote: string;
  /** Answer text [start, end) that this citation supports. */
  start: number;
  end: number;
  headingPath: string[];
}

export interface AnswerSource {
  n: number;
  headingPath: string[];
  pageStart: number;
  pageEnd: number;
  chunkIds: string[];
}

export type AskMode = 'chat' | 'ask' | 'explain' | 'summarize' | 'simplify';
export type MessageStatus = 'complete' | 'interrupted' | 'refused' | 'error';

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  mode: AskMode;
  scope: { sectionId?: string; pageStart?: number; pageEnd?: number; selection?: { text: string; page: number | null } };
  citations: AnswerCitation[];
  status: MessageStatus;
  model: string | null;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  documentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface AskBody {
  content: string;
  mode?: AskMode;
  selection?: { text: string; page?: number };
  page_start?: number;
  page_end?: number;
}

/** Server-sent events of one answer (backend/folio_ai/chat/service.py). */
export type AnswerEvent =
  | { event: 'start'; data: { conversationId: string; userMessageId: string; mode: AskMode } }
  | { event: 'sources'; data: AnswerSource[] }
  | { event: 'status'; data: { state: 'thinking' } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'citation'; data: AnswerCitation }
  | { event: 'done'; data: { messageId: string; status: MessageStatus; stopReason: string | null; model: string } }
  | { event: 'error'; data: { message: string; retryable: boolean; messageId?: string } };

/* ------------------------------- errors ------------------------------- */

export class AiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function failure(r: Response): Promise<AiHttpError> {
  let message = `${r.status} ${r.statusText}`;
  try {
    const body = await r.json();
    const d = body?.detail;
    message = typeof d === 'string' ? d : Array.isArray(d) ? d.map((x: { msg?: string }) => x.msg).join('; ') : message;
  } catch {
    /* not JSON (e.g. the dev proxy's own error page) */
    if (r.status === 502 || r.status === 504 || r.status === 500) message = 'The assistant backend is unreachable (proxy error).';
  }
  return new AiHttpError(r.status, message);
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, init);
  if (!r.ok) throw await failure(r);
  return (r.status === 204 ? undefined : await r.json()) as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/* ------------------------------- calls ------------------------------- */

export const getHealth = () => json<Health>('/health');

/** The backend's view of a document, or null when it has never been uploaded. */
export async function getAiDocument(hash: string): Promise<AiDocument | null> {
  try {
    return await json<AiDocument>(`/documents/${hash}`);
  } catch (e) {
    if (e instanceof AiHttpError && e.status === 404) return null;
    throw e;
  }
}

export function uploadDocument(file: Blob, hash: string, title: string, fileName: string) {
  const form = new FormData();
  form.append('file', file, fileName);
  form.append('sha256', hash);
  form.append('title', title);
  return json<AiDocument>('/documents', { method: 'POST', body: form });
}

export const retryDocument = (hash: string) => json<AiDocument>(`/documents/${hash}/retry`, { method: 'POST' });

/** Nothing more will change without being asked: failed, or ready with the full pass done (or given up). */
export const settled = (d: AiDocument) => d.status === 'failed' || (d.status === 'ready' && !d.refining);

/** Live ingestion status; returns a function that stops listening. */
export function watchDocument(hash: string, onStatus: (d: AiDocument) => void, onLost: () => void): () => void {
  const es = new EventSource(`${BASE}/documents/${hash}/events`);
  es.addEventListener('status', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as AiDocument;
    onStatus(d);
    if (settled(d)) es.close();
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) return;
    es.close();
    onLost();
  };
  return () => es.close();
}

/** A passage of the prepared document (backend `Passage.json()`). */
export interface Passage {
  id: string;
  sectionId: string | null;
  headingPath: string[];
  text: string;
  pageStart: number;
  pageEnd: number;
  locations: CitationLocation[];
}

/** Passages related to a selection: the selection is the query and its own passage is left out. No model call. */
export const getRelated = (hash: string, text: string, page?: number, limit = 5) =>
  json<{ selection: (Passage & { match: string }) | null; hits: Passage[] }>(`/documents/${hash}/related`, post({ text: text.slice(0, 20_000), page, limit }));

export const getSuggestions =(hash: string) => json<{ questions: string[] }>(`/documents/${hash}/suggestions`);
export const listConversations = (hash: string) => json<ConversationSummary[]>(`/documents/${hash}/conversations`);
export const createConversation = (hash: string) => json<ConversationSummary>(`/documents/${hash}/conversations`, post({}));
export const getConversation = (id: string) => json<ConversationSummary & { messages: StoredMessage[] }>(`/conversations/${id}`);
export const deleteConversation = (id: string) => json<void>(`/conversations/${id}`, { method: 'DELETE' });

/**
 * Ask in a conversation and stream the answer. Resolves when the stream ends; abort with `signal`
 * (the backend then stores the partial answer as `interrupted`).
 */
export async function ask(conversationId: string, body: AskBody, onEvent: (e: AnswerEvent) => void, signal?: AbortSignal): Promise<void> {
  const r = await fetch(`${BASE}/conversations/${conversationId}/messages`, { ...post(body), signal });
  if (!r.ok || !r.body) throw await failure(r);
  await readEvents(r.body, onEvent);
}

/** Parse a text/event-stream body into events (one `event:` and one `data:` line per frame). */
export async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (e: AnswerEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += decoder.decode(value, { stream: !done });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) onEvent({ event, data: JSON.parse(data.join('\n')) } as AnswerEvent);
    }
    if (done) return;
  }
}
