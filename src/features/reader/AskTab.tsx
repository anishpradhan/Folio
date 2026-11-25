import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowUp, FileSearch, MessageSquareText, PlugZap, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useReader } from './store';
import { getFileBlob } from '../../data/repo';
import { AutoTextarea, EmptyState, IconButton, Spinner, flash } from '../../components/ui';
import { cx } from '../../lib/util';
import { locLong, locShort } from '../../lib/locations';
import { flattenOutline, sectionForPage } from '../../core/outline';
import type { DocumentRecord, OutlineNode } from '../../core/types';
import type { AnswerCitation, AskBody, DocStage } from '../../ai/api';
import { AnswerText } from '../../ai/answer';
import { SaveAnswer } from './SaveAnswer';
import {
  askQuestion,
  checkHealth,
  loadConversations,
  loadDocument,
  loadSuggestions,
  openConversation,
  prepareDocument,
  removeConversation,
  retryPreparation,
  stopAnswer,
  useAi,
  type ChatMessage,
} from '../../ai/store';

/* ============================== citations ============================== */

/** Jump to a cited passage and flash it (exact quote when the page's text layer has it, else its paragraph box). */
export function showCitation(c: AnswerCitation) {
  const st = useReader.getState();
  const key = Date.now();
  const onPage = c.locations.filter((l) => l.page === c.page);
  st.set({ citationFlash: { key, quote: c.quote, locations: c.locations } });
  st.nav?.goTo(c.page, onPage[0] ? { y: onPage[0].rect.y } : undefined);
  setTimeout(() => {
    if (useReader.getState().citationFlash?.key === key) useReader.getState().set({ citationFlash: null });
  }, 4500);
}

export function CitationChip({ c, doc }: { c: AnswerCitation; doc: DocumentRecord }) {
  const quote = c.quote.length > 220 ? `${c.quote.slice(0, 220)}…` : c.quote;
  return (
    <button
      type="button"
      className="cite-chip"
      data-testid="citation-chip"
      data-page={c.page}
      aria-label={`Source on ${locLong(doc, c.page)}: “${quote}”`}
      data-tip={`“${quote}”`}
      onClick={() => showCitation(c)}
    >
      {locShort(doc, c.page)}
    </button>
  );
}

/* ============================== preparing the document ============================== */

export const STAGES: Record<DocStage, string> = {
  queued: 'Waiting to start',
  parsing: 'Reading the document',
  chunking: 'Splitting into passages',
  embedding: 'Indexing the meaning of each passage',
  indexing: 'Saving the search index',
  ready: 'Ready',
  failed: 'Failed',
};

function Preparation({ doc }: { doc: DocumentRecord }) {
  const state = useAi((s) => s.docs[doc.fileHash]);
  const prepare = async () => {
    const blob = await getFileBlob(doc.id);
    if (!blob) return flash('This document’s file is missing from the library.');
    await prepareDocument(doc.fileHash, blob, doc.title, doc.fileName);
  };

  if (!state || state.kind === 'loading') return <Centered><Spinner /></Centered>;
  if (state.kind === 'error')
    return (
      <EmptyState icon={<AlertTriangle size={20} />} title="Couldn’t reach the assistant" action={<button className="btn btn-outline" onClick={() => void loadDocument(doc.fileHash)}><RotateCcw size={14} /> Try again</button>}>
        {state.message}
      </EmptyState>
    );
  if (state.kind === 'missing')
    return (
      <EmptyState
        icon={<FileSearch size={20} />}
        title="Ask about this document"
        action={
          <button className="btn btn-primary" onClick={() => void prepare()} data-testid="ask-prepare">
            Prepare for questions
          </button>
        }
      >
        The assistant reads the document once to find its sections and passages. It answers from those passages and shows you where each answer comes from.
      </EmptyState>
    );

  const d = state.kind === 'known' ? state.doc : null;
  if (d?.status === 'failed')
    return (
      <EmptyState
        icon={<AlertTriangle size={20} />}
        title="Preparation failed"
        action={
          <button className="btn btn-outline" onClick={() => void retryPreparation(doc.fileHash)} data-testid="ask-retry-prepare">
            <RotateCcw size={14} /> Try again
          </button>
        }
      >
        <span data-testid="ask-prepare-error">{d.error ?? 'Something went wrong.'}</span>
      </EmptyState>
    );
  const stage = d ? STAGES[d.status] : 'Uploading';
  const pct = d ? Math.round(d.progress * 100) : 0;
  return (
    <div className="px-6 py-12 text-center" data-testid="ask-preparing" role="status" aria-live="polite">
      <Spinner className="text-accent" />
      <p className="mt-3 font-display text-[17px] text-ink">Preparing the document…</p>
      <p className="mt-1 text-[13px] text-ink-3">
        {stage}
        {d?.job && d.job.attempt > 1 ? ` · attempt ${d.job.attempt}` : ''}
      </p>
      <div className="mx-auto mt-4 h-1.5 max-w-[220px] overflow-hidden rounded-full bg-ink/[0.07]" aria-hidden>
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
      {d?.detail && <p className="mt-2 text-[11.5px] text-ink-3">{d.detail}</p>}
      <p className="mt-6 text-[12px] leading-relaxed text-ink-3">You can keep reading; this continues in the background.</p>
    </div>
  );
}

/**
 * A document answering from its quick pass (the PDF's text layer) while the full pass reads headings and
 * tables, or after that failed. Answers already work; this only says they will get better.
 */
function RefiningNote({ doc }: { doc: DocumentRecord }) {
  const d = useAi((s) => {
    const st = s.docs[doc.fileHash];
    return st?.kind === 'known' ? st.doc : null;
  });
  if (!d || d.status !== 'ready' || d.index !== 'quick') return null;
  if (!d.refining)
    return (
      <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg bg-ink/[0.04] px-3 py-2 text-[12px] leading-snug text-ink-2" data-testid="ask-refine-failed">
        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">
          Answers use the document’s plain text. Reading its headings and tables failed{d.error ? `: ${d.error}` : '.'}
        </span>
        <button className="shrink-0 font-medium text-accent hover:underline" onClick={() => void retryPreparation(doc.fileHash)} data-testid="ask-refine-retry">
          Try again
        </button>
      </div>
    );
  return (
    <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg bg-ink/[0.04] px-3 py-2 text-[12px] leading-snug text-ink-2" aria-live="polite" data-testid="ask-refining">
      <Spinner size={12} className="mt-0.5 shrink-0 text-accent" />
      <span className="min-w-0">
        Answering from the plain text for now. Headings and tables are still being read, and answers will use them when that finishes.
        {d.detail && <span className="block text-[11.5px] text-ink-3">{d.detail}</span>}
      </span>
    </div>
  );
}

const Centered = ({ children }: { children: React.ReactNode }) => <div className="grid place-items-center py-16 text-ink-3">{children}</div>;

/* ============================== messages ============================== */

function sourcesOf(m: ChatMessage) {
  const seen = new Map<number, AnswerCitation>();
  for (const c of m.citations) if (!seen.has(c.source)) seen.set(c.source, c);
  return [...seen.values()].sort((a, b) => a.page - b.page);
}

function Message({ m, question, doc, onRetry }: { m: ChatMessage; question?: ChatMessage; doc: DocumentRecord; onRetry: (body: AskBody) => void }) {
  if (m.role === 'user')
    return (
      <li className="flex flex-col items-end gap-1" data-testid="ask-question">
        {m.selection && <blockquote className="max-w-[92%] border-l-2 border-accent/50 pl-2 font-serif text-[12.5px] leading-snug text-ink-3 line-clamp-3">{m.selection}</blockquote>}
        <p className="max-w-[92%] rounded-2xl rounded-br-md bg-accent-soft px-3 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">{m.content}</p>
      </li>
    );
  const streaming = m.status === 'streaming';
  const sources = sourcesOf(m);
  return (
    <li className="text-[13.5px] leading-relaxed text-ink" data-testid="ask-answer" data-status={m.status}>
      {streaming && !m.content && (
        <p className="flex items-center gap-2 text-ink-3" data-testid="ask-thinking">
          <Spinner size={13} /> {m.thinking ? 'Thinking…' : 'Finding passages…'}
        </p>
      )}
      {m.content && (
        <div className={cx('answer', streaming && 'is-streaming')}>
          <AnswerText text={m.content} citations={m.citations} renderChip={(c, key) => <CitationChip key={key} c={c} doc={doc} />} />
        </div>
      )}
      {m.status === 'refused' && <p className="text-ink-3 italic">The assistant declined to answer this request.</p>}
      {m.status === 'interrupted' && <p className="mt-1 text-[12px] text-ink-3">Stopped.</p>}
      {m.status === 'error' && (
        <div className="mt-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] text-ink-2" role="alert" data-testid="ask-error">
          <p>{m.error ?? 'The answer couldn’t be completed.'}</p>
          {m.request && (
            <button className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline" onClick={() => onRetry(m.request!)}>
              <RotateCcw size={12} /> Ask again
            </button>
          )}
        </div>
      )}
      {!streaming && sources.length > 0 && (
        <div className="mt-2.5 border-t border-line pt-2">
          <p className="mb-1 text-[11px] font-medium tracking-wide text-ink-3 uppercase">Sources</p>
          <ul className="space-y-0.5">
            {sources.map((c) => (
              <li key={c.source}>
                <button className="flex w-full gap-2 rounded px-1 py-0.5 text-left text-[12px] text-ink-2 hover:bg-ink/[0.04]" onClick={() => showCitation(c)} data-testid="ask-source">
                  <span className="shrink-0 tabular-nums text-ink-3">{locShort(doc, c.page)}</span>
                  <span className="truncate">{c.headingPath.length ? c.headingPath[c.headingPath.length - 1] : 'Passage'}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!streaming && m.content && (m.status === 'complete' || m.status === 'interrupted') && (
        <div className="mt-1.5 -ml-2">
          <SaveAnswer
            doc={doc}
            answer={{
              mode: m.mode,
              question: question?.role === 'user' && (m.mode === 'chat' || m.mode === 'ask') ? question.content : '',
              selection: question?.selection,
              selectionPage: question?.selectionPage,
              text: m.content,
              citations: m.citations,
            }}
          />
        </div>
      )}
    </li>
  );
}

/* ============================== scope ============================== */

/** The outline entry around `page` and the pages it covers (until the next entry at the same or a higher level). */
function sectionRange(doc: DocumentRecord, page: number): { node: OutlineNode; start: number; end: number } | null {
  const node = sectionForPage(doc.outline, page);
  if (!node || node.page == null) return null;
  const flat = flattenOutline(doc.outline).filter((f) => f.node.page != null);
  const i = flat.findIndex((f) => f.node === node);
  const depth = flat[i]?.depth ?? 0;
  const next = flat.slice(i + 1).find((f) => f.depth <= depth && (f.node.page as number) > (node.page as number));
  return { node, start: node.page, end: next ? (next.node.page as number) - 1 : doc.pageCount };
}

/* ============================== chat ============================== */

function Chat({ doc, configured, model, keyName }: { doc: DocumentRecord; configured: boolean; model: string; keyName: string }) {
  const hash = doc.fileHash;
  const conversations = useAi((s) => s.conversations[hash]);
  const active = useAi((s) => s.active[hash]);
  const messages = useAi((s) => (active ? s.messages[active] : undefined)) ?? [];
  const streaming = useAi((s) => s.streaming);
  const suggestions = useAi((s) => s.suggestions[hash]);
  const page = useReader((s) => s.page);
  const [draft, setDraft] = useState('');
  const [scoped, setScoped] = useState(false);
  const section = useMemo(() => sectionRange(doc, page), [doc, page]);
  const listRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = !!streaming;

  useEffect(() => {
    if (conversations === undefined) void loadConversations(hash, { openLatest: true }).catch((e) => flash(String(e?.message ?? e)));
  }, [hash, conversations]);
  useEffect(() => {
    if (configured && !messages.length) void loadSuggestions(hash);
  }, [configured, hash, messages.length]);

  // Follow the answer as it streams, unless the reader has scrolled up to read.
  const last = messages[messages.length - 1];
  const stick = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [last?.content, last?.status, messages.length, active]);

  const send = (body: AskBody) => {
    stick.current = true;
    void askQuestion(hash, body).catch((e) => flash(String(e?.message ?? e)));
  };
  const submit = (text = draft) => {
    const q = text.trim();
    if (!q || busy || !configured) return;
    setDraft('');
    send({ content: q, ...(scoped && section ? { page_start: section.start, page_end: section.end } : {}) });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ask-chat">
      <div className="flex items-center gap-1.5 px-4 pb-2">
        <select
          className="field h-8 min-w-0 flex-1 py-0 text-[12.5px]"
          aria-label="Conversation"
          data-testid="ask-conversation"
          value={active ?? ''}
          disabled={busy}
          onChange={(e) => void openConversation(hash, e.target.value || null)}
        >
          <option value="">New conversation</option>
          {(conversations ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.title || 'Untitled conversation'}
            </option>
          ))}
        </select>
        {active && (
          <IconButton
            label="Delete conversation"
            className="h-8 w-8"
            disabled={busy}
            onClick={() => void removeConversation(hash, active).then(() => flash('Conversation deleted'))}
          >
            <Trash2 size={14} />
          </IconButton>
        )}
      </div>

      <RefiningNote doc={doc} />

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {messages.length === 0 ? (
          <div className="pt-6" data-testid="ask-empty">
            <p className="font-display text-[17px] text-ink">What would you like to know?</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">Answers come from this document, with links to the passages they rely on.</p>
            {configured && suggestions === null && (
              <p className="mt-4 flex items-center gap-2 text-[12px] text-ink-3">
                <Spinner size={12} /> Suggesting questions…
              </p>
            )}
            {configured && suggestions && suggestions.length > 0 && (
              <ul className="mt-4 space-y-1.5">
                {suggestions.map((q) => (
                  <li key={q}>
                    <button className="w-full rounded-xl border border-line px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:border-line-2 hover:bg-ink/[0.03] hover:text-ink" onClick={() => submit(q)} data-testid="ask-suggestion">
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <ol className="space-y-5" role="log" aria-live="polite" aria-busy={busy} data-testid="ask-messages">
            {messages.map((m, i) => (
              <Message key={m.id} m={m} question={messages[i - 1]} doc={doc} onRetry={send} />
            ))}
          </ol>
        )}
      </div>

      <div className="border-t border-line px-4 pt-3 pb-4">
        {!configured ? (
          <p className="rounded-lg bg-ink/[0.04] px-3 py-2 text-[12.5px] leading-relaxed text-ink-2" data-testid="ask-not-configured">
            Answers need an API key. Add <code className="font-mono text-[11.5px]">{keyName}</code> to <code className="font-mono text-[11.5px]">backend/.env</code> and restart the backend.
          </p>
        ) : (
          <>
            <div className="relative">
              <AutoTextarea
                ref={input}
                minRows={1}
                aria-label="Ask about this document"
                data-testid="ask-input"
                placeholder={scoped && section ? `Ask about “${section.node.title}”…` : 'Ask about this document…'}
                className="max-h-40 pr-11 text-[13.5px]"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              {busy ? (
                <IconButton label="Stop" className="absolute right-1.5 bottom-1.5 h-7 w-7 bg-ink text-bg hover:bg-ink/85" onClick={stopAnswer} data-testid="ask-stop">
                  <Square size={11} className="fill-current" />
                </IconButton>
              ) : (
                <IconButton label="Send" className="absolute right-1.5 bottom-1.5 h-7 w-7 bg-accent text-accent-ink hover:bg-accent/90 disabled:opacity-40" disabled={!draft.trim()} onClick={() => submit()} data-testid="ask-send">
                  <ArrowUp size={14} />
                </IconButton>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-[11.5px] text-ink-3">
              {section ? (
                <label className="flex min-w-0 items-center gap-1.5">
                  <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} data-testid="ask-scope" />
                  <span className="truncate">
                    Only this section{scoped ? ` · ${section.node.title} (${section.start === section.end ? locShort(doc, section.start) : `pp. ${section.start}–${section.end}`})` : ''}
                  </span>
                </label>
              ) : (
                <span />
              )}
              <span className="shrink-0" title={`Answers by ${model}`}>
                Shift+Enter for a new line
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================== tab ============================== */

export function AskTab() {
  const doc = useReader((s) => s.doc)!;
  const health = useAi((s) => s.health);
  const state = useAi((s) => s.docs[doc.fileHash]);

  useEffect(() => {
    if (health.kind !== 'online') void checkHealth();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (health.kind === 'online' && doc.format === 'pdf' && (!state || state.kind === 'error')) void loadDocument(doc.fileHash);
  }, [health.kind, doc.fileHash, doc.format]); // eslint-disable-line react-hooks/exhaustive-deps

  if (doc.format !== 'pdf')
    return (
      <EmptyState icon={<MessageSquareText size={20} />} title="Not available for EPUB yet">
        Questions about EPUB books are planned. For now the assistant works with PDFs.
      </EmptyState>
    );
  if (health.kind === 'checking') return <Centered><Spinner /></Centered>;
  if (health.kind === 'offline')
    return (
      <EmptyState
        icon={<PlugZap size={20} />}
        title="Assistant offline"
        action={
          <button className="btn btn-outline" onClick={() => void checkHealth()} data-testid="ask-reconnect">
            <RotateCcw size={14} /> Try again
          </button>
        }
      >
        <span data-testid="ask-offline">
          The assistant’s backend isn’t running. Start it with <code className="font-mono text-[12px]">npm run ai</code>. Everything else in the reader works without it.
        </span>
      </EmptyState>
    );
  const ready = state?.kind === 'known' && state.doc.status === 'ready';
  if (!ready) return <Preparation doc={doc} />;
  const llm = health.health.llm;
  return <Chat doc={doc} configured={llm.configured} model={llm.model} keyName={llm.provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} />;
}
