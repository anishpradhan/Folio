import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowUp, Feather, Lightbulb, Link2, ListCollapse, MessageSquareText, RotateCcw, Sparkles, Square, X } from 'lucide-react';
import { useReader, type AiCardRequest } from './store';
import { usePrefs } from '../../state/prefs';
import { getFileBlob } from '../../data/repo';
import { Floating, IconButton, Spinner } from '../../components/ui';
import { cx } from '../../lib/util';
import { locShort } from '../../lib/locations';
import { getRelated, type AskMode, type Passage } from '../../ai/api';
import { AnswerText } from '../../ai/answer';
import { askQuestion, checkHealth, loadDocument, modeLabel, openConversation, prepareDocument, retryPreparation, stopAnswer, useAi } from '../../ai/store';
import { CitationChip, STAGES, showCitation } from './AskTab';
import { SaveAnswer } from './SaveAnswer';
import type { DocumentRecord } from '../../core/types';

/**
 * The selection assistant (phase 5): Explain, Summarize, Simplify, Ask… and Find related for the selected
 * text, answered in a card next to the selection.
 *
 * Each card keeps its answers in a conversation of its own, so "Continue in chat" just opens that
 * conversation in the Ask tab, where follow-up questions see the explanation.
 */

type View = { kind: 'menu' } | { kind: 'answer'; mode: AskMode; question: string; from: number } | { kind: 'related' };
type Related = { status: 'loading' } | { status: 'done'; hits: Passage[] } | { status: 'error'; message: string };

const MODES: { mode: 'explain' | 'summarize' | 'simplify'; label: string; icon: React.ReactNode; tip: string }[] = [
  { mode: 'explain', label: 'Explain', icon: <Lightbulb size={16} />, tip: 'What it means, in the context of the document' },
  { mode: 'summarize', label: 'Summarize', icon: <ListCollapse size={16} />, tip: 'The main point in a few sentences' },
  { mode: 'simplify', label: 'Simplify', icon: <Feather size={16} />, tip: 'The same idea in plain words' },
];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Navigate to a passage and flash its paragraphs. */
const showPassage = (p: Passage) =>
  showCitation({ id: 0, source: 0, chunkId: p.id, page: p.pageStart, locations: p.locations, quote: '', start: 0, end: 0, headingPath: p.headingPath });

export function SelectionAssistant({ req }: { req: AiCardRequest }) {
  const doc = useReader((s) => s.doc)!;
  const set = useReader((s) => s.set);
  const hash = doc.fileHash;
  const health = useAi((s) => s.health);
  const docState = useAi((s) => s.docs[hash]);
  const streaming = useAi((s) => s.streaming);

  const [view, setView] = useState<View>({ kind: 'menu' });
  const [cid, setCid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [related, setRelated] = useState<Related | null>(null);
  const messages = useAi((s) => (cid ? s.messages[cid] : undefined));
  const cidRef = useRef<string | null>(null);
  const continued = useRef(false);

  useEffect(() => {
    if (health.kind === 'checking') void checkHealth();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (health.kind === 'online' && (!docState || docState.kind === 'error')) void loadDocument(hash);
  }, [health.kind, hash]); // eslint-disable-line react-hooks/exhaustive-deps

  // Closing the card stops its answer (stored as interrupted), unless it moved to the Ask tab.
  useEffect(
    () => () => {
      const s = useAi.getState().streaming;
      if (!continued.current && s && s.conversationId === cidRef.current) stopAnswer();
    },
    [],
  );

  const close = () => set({ aiCard: null });
  const selection = { text: req.text.slice(0, 20_000), page: req.page };

  const run = (mode: AskMode, question = '') => {
    if (useAi.getState().streaming) {
      setFailure('Another answer is still being written. Wait for it to finish, or stop it in the Ask tab.');
      return;
    }
    setFailure(null);
    const from = cidRef.current ? (useAi.getState().messages[cidRef.current]?.length ?? 0) : 0;
    setView({ kind: 'answer', mode, question, from });
    void askQuestion(hash, { content: question, mode, selection }, {
      conversation: cidRef.current ?? 'new',
      onConversation: (id) => {
        cidRef.current = id;
        setCid(id);
      },
    }).catch((e) => setFailure(errorText(e)));
  };

  const findRelated = () => {
    setView({ kind: 'related' });
    setRelated({ status: 'loading' });
    getRelated(hash, selection.text, selection.page)
      .then((r) => setRelated({ status: 'done', hits: r.hits }))
      .catch((e) => setRelated({ status: 'error', message: errorText(e) }));
  };

  const continueInChat = () => {
    if (!cid) return;
    continued.current = true;
    usePrefs.getState().set({ rightOpen: true, rightTab: 'ask' });
    void openConversation(hash, cid);
    close();
  };

  const answer = view.kind === 'answer' ? messages?.[view.from + 1] : undefined;
  const answerBusy = view.kind === 'answer' && (!answer || answer.status === 'streaming') && !failure;
  const ready = docState?.kind === 'known' && docState.doc.status === 'ready';
  const configured = health.kind === 'online' && health.health.llm.configured;
  const keyName = health.kind === 'online' && health.health.llm.provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';

  const title = view.kind === 'menu' ? 'Ask AI' : view.kind === 'related' ? 'Related passages' : view.mode === 'ask' ? 'Your question' : modeLabel(view.mode).replace(' this passage', '');

  let body: React.ReactNode;
  if (health.kind === 'checking' || (health.kind === 'online' && (!docState || docState.kind === 'loading'))) {
    body = (
      <div className="grid place-items-center py-6 text-ink-3">
        <Spinner />
      </div>
    );
  } else if (health.kind === 'offline') {
    body = (
      <Notice testId="ai-offline">
        The assistant’s backend isn’t running. Start it with <code className="font-mono text-[11.5px]">npm run ai</code>.
      </Notice>
    );
  } else if (!ready) {
    body = <Prepare doc={doc} />;
  } else if (view.kind === 'menu') {
    body = (
      <>
        <div className="grid grid-cols-4 gap-1">
          {MODES.map((m) => (
            <ModeButton key={m.mode} icon={m.icon} label={m.label} tip={m.tip} disabled={!configured} testId={`ai-mode-${m.mode}`} onClick={() => run(m.mode)} />
          ))}
          <ModeButton icon={<Link2 size={16} />} label="Related" tip="Other passages on the same topic" testId="ai-mode-related" onClick={findRelated} />
        </div>
        {configured ? (
          <div className="relative mt-2.5">
            <input
              className="field h-10 w-full pr-10 text-[13px]"
              placeholder="Ask about this passage…"
              aria-label="Ask about this passage"
              data-testid="ai-question"
              value={draft}
              maxLength={4000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation(); // reader shortcuts stay out of the text field
                if (e.key === 'Enter' && draft.trim() && !e.nativeEvent.isComposing) run('ask', draft.trim());
              }}
            />
            <IconButton label="Ask" className="absolute top-1.5 right-1.5 h-7 w-7 bg-accent text-accent-ink hover:bg-accent/90 disabled:opacity-40" disabled={!draft.trim()} onClick={() => run('ask', draft.trim())} data-testid="ai-ask">
              <ArrowUp size={14} />
            </IconButton>
          </div>
        ) : (
          <Notice testId="ai-not-configured">
            Explanations need an API key: add <code className="font-mono text-[11.5px]">{keyName}</code> to <code className="font-mono text-[11.5px]">backend/.env</code> and restart the backend. Related passages work without one.
          </Notice>
        )}
        {failure && <Notice testId="ai-failure">{failure}</Notice>}
      </>
    );
  } else if (view.kind === 'related') {
    body =
      !related || related.status === 'loading' ? (
        <p className="flex items-center gap-2 py-2 text-[12.5px] text-ink-3">
          <Spinner size={12} /> Finding related passages…
        </p>
      ) : related.status === 'error' ? (
        <Notice testId="ai-failure">{related.message}</Notice>
      ) : related.hits.length === 0 ? (
        <p className="py-2 text-[12.5px] text-ink-3">No other passages found.</p>
      ) : (
        <ul className="-mx-1 space-y-0.5" data-testid="ai-related">
          {related.hits.map((p) => (
            <li key={p.id}>
              <button className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-ink/[0.04]" onClick={() => showPassage(p)} data-testid="ai-related-hit" data-page={p.pageStart}>
                <span className="flex items-baseline gap-2 text-[12px]">
                  <span className="shrink-0 tabular-nums text-ink-3">{locShort(doc, p.pageStart)}</span>
                  <span className="truncate font-medium text-ink-2">{p.headingPath.length ? p.headingPath[p.headingPath.length - 1] : 'Passage'}</span>
                </span>
                <span className="mt-0.5 line-clamp-2 font-serif text-[12.5px] leading-snug text-ink-3">{p.text}</span>
              </button>
            </li>
          ))}
        </ul>
      );
  } else {
    body = (
      <div data-testid="ai-answer" data-status={failure ? 'error' : (answer?.status ?? 'streaming')} className="text-[13.5px] leading-relaxed text-ink">
        {view.question && <p className="mb-2 text-[12.5px] text-ink-3">“{view.question}”</p>}
        {answerBusy && !answer?.content && (
          <p className="flex items-center gap-2 text-ink-3">
            <Spinner size={13} /> {answer?.thinking ? 'Thinking…' : 'Reading the passage…'}
          </p>
        )}
        {answer?.content && (
          <div className={cx('answer', answer.status === 'streaming' && 'is-streaming')}>
            <AnswerText text={answer.content} citations={answer.citations} renderChip={(c, key) => <CitationChip key={key} c={c} doc={doc} />} />
          </div>
        )}
        {answer?.status === 'refused' && <p className="text-ink-3 italic">The assistant declined to answer this request.</p>}
        {answer?.status === 'interrupted' && <p className="mt-1 text-[12px] text-ink-3">Stopped.</p>}
        {(failure || answer?.status === 'error') && (
          <div className="mt-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] text-ink-2" role="alert" data-testid="ai-failure">
            <p>{failure ?? answer?.error ?? 'The answer couldn’t be completed.'}</p>
            <button className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline" onClick={() => run(view.mode, view.question)}>
              <RotateCcw size={12} /> Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  return (
    <Floating anchor={req.anchor} onClose={close} placement="bottom" offset={coarse ? 30 : 10} label="Ask AI about the selection" testId="ai-card" className="flex max-h-[min(70vh,560px)] w-[380px] max-w-[calc(100vw-16px)] flex-col p-0">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        {view.kind !== 'menu' && !answerBusy ? (
          <IconButton label="Back" className="h-8 w-8" onClick={() => setView({ kind: 'menu' })} data-testid="ai-back">
            <ArrowLeft size={15} />
          </IconButton>
        ) : (
          <span className="grid h-8 w-8 place-items-center text-accent">
            <Sparkles size={15} />
          </span>
        )}
        <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{title}</p>
        <IconButton label="Close" className="h-8 w-8" onClick={close} data-testid="ai-close">
          <X size={15} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-3.5">
        <blockquote className="mb-3 line-clamp-3 border-l-2 border-accent/50 pl-2 font-serif text-[12.5px] leading-snug text-ink-3">{req.text}</blockquote>
        {body}
      </div>
      {view.kind === 'answer' && (answerBusy || (answer && cid)) && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-3 py-2">
          {!answerBusy && answer?.content && (answer.status === 'complete' || answer.status === 'interrupted') && (
            <SaveAnswer
              key={answer.id}
              className="mr-auto"
              doc={doc}
              parts={req.parts}
              answer={{ mode: view.mode, question: view.question, selection: req.text, selectionPage: req.page, text: answer.content, citations: answer.citations }}
            />
          )}
          {answerBusy && streaming?.conversationId === cid ? (
            <button className="btn btn-outline h-8 text-[12.5px]" onClick={stopAnswer} data-testid="ai-stop">
              <Square size={11} className="fill-current" /> Stop
            </button>
          ) : (
            !answerBusy && (
              <button className="btn btn-primary h-8 text-[12.5px]" onClick={continueInChat} data-testid="ai-continue">
                <MessageSquareText size={14} /> Continue in chat
              </button>
            )
          )}
        </div>
      )}
    </Floating>
  );
}

function ModeButton({ icon, label, tip, disabled, testId, onClick }: { icon: React.ReactNode; label: string; tip: string; disabled?: boolean; testId: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      data-tip={tip}
      className="flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-ink/5 hover:text-ink disabled:pointer-events-none disabled:opacity-40 pointer-coarse:py-2.5"
    >
      {icon}
      {label}
    </button>
  );
}

const Notice = ({ children, testId }: { children: React.ReactNode; testId?: string }) => (
  <p className="mt-2.5 rounded-lg bg-ink/[0.04] px-3 py-2 text-[12.5px] leading-relaxed text-ink-2" data-testid={testId} role="status">
    {children}
  </p>
);

/** The document hasn't been prepared: offer it here, with live progress; the menu appears once it's ready. */
function Prepare({ doc }: { doc: DocumentRecord }) {
  const state = useAi((s) => s.docs[doc.fileHash]);
  const [error, setError] = useState<string | null>(null);
  const prepare = async () => {
    const blob = await getFileBlob(doc.id);
    if (!blob) return setError('This document’s file is missing from the library.');
    await prepareDocument(doc.fileHash, blob, doc.title, doc.fileName);
  };
  if (state?.kind === 'error' || error)
    return (
      <Notice testId="ai-failure">
        <AlertTriangle size={13} className="mr-1 inline" />
        {error ?? (state?.kind === 'error' ? state.message : '')}
      </Notice>
    );
  if (state?.kind === 'missing')
    return (
      <div className="text-[12.5px] leading-relaxed text-ink-2">
        <p>The assistant needs to read this document once before it can help. For a paper this takes a minute or two.</p>
        <button className="btn btn-primary mt-2.5 h-8 text-[12.5px]" onClick={() => void prepare()} data-testid="ai-prepare">
          Prepare this document
        </button>
      </div>
    );
  const d = state?.kind === 'known' ? state.doc : null;
  if (d?.status === 'failed')
    return (
      <div className="text-[12.5px] text-ink-2">
        <p data-testid="ai-prepare-error">Preparation failed: {d.error ?? 'something went wrong.'}</p>
        <button className="btn btn-outline mt-2 h-8 text-[12.5px]" onClick={() => void retryPreparation(doc.fileHash)}>
          <RotateCcw size={13} /> Try again
        </button>
      </div>
    );
  const pct = d ? Math.round(d.progress * 100) : 0;
  return (
    <div role="status" aria-live="polite" data-testid="ai-preparing">
      <p className="flex items-center gap-2 text-[12.5px] text-ink-2">
        <Spinner size={12} /> Preparing the document · {d ? STAGES[d.status] : 'Uploading'}
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/[0.07]" aria-hidden>
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
      {d?.detail && <p className="mt-1.5 text-[11.5px] text-ink-3">{d.detail}</p>}
      <p className="mt-2 text-[11.5px] text-ink-3">You can keep reading. The options appear here when it’s ready.</p>
    </div>
  );
}
