import { useEffect, useRef, useState } from 'react';
import { NotebookPen, Bookmark, BookA, Copy, Trash2, Star, Volume2, Check, Plus, ExternalLink, RotateCw, WifiOff, SearchX, Sparkles } from 'lucide-react';
import { useReader, closePopovers } from './store';
import { copyText, highlightSelection, removeHighlight } from './actions';
import { Floating, flash } from '../../components/ui';
import { HL_COLORS, InlineEditor } from './RightSidebar';
import { addBookmark, findVocabulary, saveVocabulary, updateHighlight, listBookmarks } from '../../data/repo';
import { lookupTerm, lookupWord, DictionaryError } from '../../core/dictionary';
import type { DictionaryEntry } from '../../core/types';
import { cx, relativeTime } from '../../lib/util';
import { locLong } from '../../lib/locations';
import { autoPrepare, checkHealth, useAi } from '../../ai/store';
import { SelectionAssistant } from './SelectionAssistant';

const ToolButton = ({ icon, label, onClick, testId }: { icon: React.ReactNode; label: string; onClick: () => void; testId?: string }) => (
  <button onClick={onClick} data-testid={testId} className="flex flex-col items-center gap-0.5 rounded-lg px-2.5 py-1.5 text-[10.5px] font-medium text-ink-2 transition-colors hover:bg-ink/5 hover:text-ink pointer-coarse:px-3 pointer-coarse:py-2">
    {icon}
    {label}
  </button>
);

/* ============================== Selection toolbar ============================== */

function SelectionToolbar() {
  const sel = useReader((s) => s.selection)!;
  const doc = useReader((s) => s.doc)!;
  const set = useReader((s) => s.set);
  const words = sel.text.split(/\s+/).length;
  // The assistant works on prepared PDFs; without a running backend the toolbar stays as it was.
  const aiOnline = useAi((s) => s.health.kind === 'online');
  const askAi = () => set({ aiCard: { text: sel.text, page: sel.parts[0].page, anchor: sel.anchor, parts: sel.parts }, selection: null });

  const bookmark = async () => {
    const page = sel.parts[0].page;
    const existing = (await listBookmarks(doc.id)).find((b) => b.page === page);
    if (!existing) await addBookmark(doc.id, page, sel.text.length < 80 ? sel.text : '');
    flash(existing ? `${locLong(doc, page)} is already bookmarked` : `Bookmarked · ${locLong(doc, page)}`);
    window.getSelection()?.removeAllRanges();
    closePopovers();
  };
  const lookup = () => {
    set({ dictionary: { term: lookupTerm(sel.text.split(/\s+/).slice(0, 4).join(' ')), anchor: sel.anchor, page: sel.parts[0].page, context: sel.context }, selection: null });
  };

  // On touch screens the OS shows its own copy/select-all bar above the selection (web pages
  // can't remove it), so ours sits below, clear of the selection handles.
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  return (
    <Floating anchor={sel.anchor} onClose={closePopovers} placement={coarse ? 'bottom' : 'top'} offset={coarse ? 30 : 8} role="toolbar" label="Selection actions" className="flex items-center gap-1 p-1.5">
      <div className="flex items-center gap-1.5 px-1.5" role="group" aria-label="Highlight colour">
        {HL_COLORS.map((c) => (
          <button
            key={c.id}
            aria-label={`Highlight ${c.label.toLowerCase()}`}
            data-tip={`Highlight · ${c.label}`}
            data-testid={`hl-${c.id}`}
            onClick={() => void highlightSelection(c.id)}
            className={cx('h-[22px] w-[22px] rounded-full transition-transform hover:scale-115 focus-visible:scale-115 pointer-coarse:h-7 pointer-coarse:w-7', `hl-${c.id}`)}
            style={{ background: 'var(--hl)', boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.1)' }}
          />
        ))}
      </div>
      <span className="mx-1 h-8 w-px bg-line" />
      <ToolButton icon={<NotebookPen size={16} />} label="Note" testId="sel-note" onClick={() => void highlightSelection('yellow', { openNote: true })} />
      <ToolButton icon={<Bookmark size={16} />} label="Bookmark" testId="sel-bookmark" onClick={() => void bookmark()} />
      {words <= 4 && <ToolButton icon={<BookA size={16} />} label="Define" testId="sel-define" onClick={lookup} />}
      {aiOnline && doc.format === 'pdf' && <ToolButton icon={<Sparkles size={16} />} label="Ask AI" testId="sel-ask-ai" onClick={askAi} />}
      <ToolButton
        icon={<Copy size={16} />}
        label="Copy"
        testId="sel-copy"
        onClick={() => {
          void copyText(sel.text);
          closePopovers();
        }}
      />
    </Floating>
  );
}

/* ============================== Highlight card ============================== */

function HighlightCard() {
  const active = useReader((s) => s.activeHighlight)!;
  const h = useReader((s) => s.highlights.find((x) => x.id === active.id));
  const doc = useReader((s) => s.doc);
  const set = useReader((s) => s.set);
  if (!h) return null;
  const short = h.text.split(/\s+/).length <= 4;
  return (
    <Floating anchor={active.anchor} onClose={closePopovers} placement="bottom" label="Highlight" className="w-[340px] p-0">
      <div className={cx('rounded-t-[14px] px-4 pt-3.5 pb-3', `hl-${h.color}`)} style={{ background: 'color-mix(in srgb, var(--hl) 22%, transparent)' }}>
        <p className="line-clamp-4 font-serif text-[13.5px] leading-relaxed text-ink">“{h.text}”</p>
        <p className="mt-1.5 text-[11px] text-ink-3">
          {locLong(doc, h.page)} · saved {relativeTime(h.createdAt).toLowerCase()}
        </p>
      </div>
      <div className="px-4 pt-3 pb-3">
        <InlineEditor label="Note" autoFocus={active.focusNote} value={h.note} placeholder="Add a note to this passage…" onSave={(v) => void updateHighlight(h.id, { note: v })} />
        <div className="mt-3 flex items-center gap-1">
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Highlight colour">
            {HL_COLORS.map((c) => (
              <button
                key={c.id}
                role="radio"
                aria-checked={h.color === c.id}
                aria-label={c.label}
                data-tip={c.label}
                onClick={() => void updateHighlight(h.id, { color: c.id })}
                className={cx('grid h-5 w-5 place-items-center rounded-full', `hl-${c.id}`, h.color === c.id && 'ring-2 ring-ink/30 ring-offset-1 ring-offset-surface')}
                style={{ background: 'var(--hl)' }}
              />
            ))}
          </div>
          <span className="flex-1" />
          <button className={cx('icon-btn h-8 w-8', h.important && 'is-on')} aria-label="Important passage" data-tip={h.important ? 'Marked important' : 'Mark as important'} onClick={() => void updateHighlight(h.id, { important: !h.important })}>
            <Star size={15} className={h.important ? 'fill-current' : ''} />
          </button>
          {short && (
            <button className="icon-btn h-8 w-8" aria-label="Look up" data-tip="Look up meaning" onClick={() => set({ dictionary: { term: lookupTerm(h.text), anchor: active.anchor, page: h.page, context: h.text }, activeHighlight: null })}>
              <BookA size={15} />
            </button>
          )}
          <button className="icon-btn h-8 w-8" aria-label="Copy text" data-tip="Copy" onClick={() => void copyText(h.text)}>
            <Copy size={15} />
          </button>
          <button className="icon-btn h-8 w-8 hover:!text-danger" aria-label="Delete highlight" data-tip="Delete" data-testid="hl-delete" onClick={() => void removeHighlight(h)}>
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </Floating>
  );
}

/* ============================== Dictionary ============================== */

type DictState = { status: 'loading' } | { status: 'found'; entry: DictionaryEntry } | { status: 'missing' } | { status: 'error'; message: string; offline: boolean };

function DictionaryCard() {
  const req = useReader((s) => s.dictionary)!;
  const doc = useReader((s) => s.doc)!;
  const set = useReader((s) => s.set);
  const [term, setTerm] = useState(req.term);
  const [state, setState] = useState<DictState>({ status: 'loading' });
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => setTerm(req.term), [req.term]);

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: 'loading' });
    setSaved(false);
    lookupWord(term, ctrl.signal)
      .then(async (entry) => {
        if (ctrl.signal.aborted) return;
        if (!entry) return setState({ status: 'missing' });
        setState({ status: 'found', entry });
        setSaved(!!(await findVocabulary(entry.word)));
      })
      .catch((e) => {
        if ((e as Error).name === 'AbortError') return;
        setState({ status: 'error', message: e instanceof DictionaryError ? e.message : 'The dictionary could not be reached.', offline: e instanceof DictionaryError && e.kind === 'offline' });
      });
    return () => ctrl.abort();
  }, [term, attempt]);

  const save = async () => {
    if (state.status !== 'found') return;
    await saveVocabulary(state.entry, { docId: doc.id, page: req.page, context: req.context });
    setSaved(true);
    flash(`“${state.entry.word}” saved to your vocabulary`);
  };

  return (
    <Floating anchor={req.anchor} onClose={() => set({ dictionary: null })} placement="bottom" label="Dictionary" className="w-[360px] max-w-[calc(100vw-16px)] p-0">
      <div className="max-h-[min(460px,70vh)] overflow-y-auto px-5 pt-4 pb-4" data-testid="dictionary">
        {state.status === 'loading' && (
          <div aria-busy="true">
            <div className="font-display text-[24px] font-medium">{term}</div>
            <div className="mt-3 space-y-2">
              <div className="h-2.5 w-1/3 animate-pulse rounded bg-ink/10" />
              <div className="h-2.5 w-full animate-pulse rounded bg-ink/[0.07]" />
              <div className="h-2.5 w-4/5 animate-pulse rounded bg-ink/[0.07]" />
            </div>
          </div>
        )}
        {state.status === 'found' && (
          <>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-display text-[26px] leading-tight font-medium tracking-tight" data-testid="dict-word">
                  {state.entry.word}
                </div>
                {state.entry.phonetic && <div className="mt-0.5 font-serif text-[14px] text-ink-3">{state.entry.phonetic}</div>}
              </div>
              {state.entry.audioUrl && (
                <button
                  className="icon-btn mt-1"
                  aria-label="Play pronunciation"
                  data-tip="Pronounce"
                  onClick={() => {
                    audioRef.current?.pause();
                    audioRef.current = new Audio(state.entry.audioUrl!);
                    void audioRef.current.play().catch(() => flash('Audio could not be played'));
                  }}
                >
                  <Volume2 size={17} />
                </button>
              )}
            </div>
            <div className="mt-3 space-y-4">
              {state.entry.meanings.slice(0, 3).map((m) => (
                <section key={m.partOfSpeech}>
                  <div className="eyebrow mb-1.5 text-accent">{m.partOfSpeech}</div>
                  <ol className="space-y-2">
                    {m.definitions.slice(0, 3).map((d, i) => (
                      <li key={i} className="text-[13.5px] leading-relaxed text-ink">
                        {m.definitions.length > 1 && <span className="mr-1.5 text-ink-3 tabular-nums">{i + 1}.</span>}
                        {d.definition}
                        {d.example && <p className="mt-1 border-l-2 border-line-2 pl-2.5 font-serif text-[13px] text-ink-2 italic">“{d.example}”</p>}
                      </li>
                    ))}
                  </ol>
                  {m.synonyms.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] text-ink-3">Similar</span>
                      {m.synonyms.slice(0, 6).map((s) => (
                        <button key={s} className="rounded-full bg-ink/[0.05] px-2 py-0.5 text-[12px] text-ink-2 hover:bg-accent/15 hover:text-accent" onClick={() => setTerm(s)}>
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
          </>
        )}
        {state.status === 'missing' && (
          <div className="py-2 text-center">
            <SearchX size={20} className="mx-auto mb-2 text-ink-3" />
            <div className="font-display text-[18px]">No entry for “{term}”</div>
            <p className="mt-1 text-[12.5px] text-ink-3">The dictionary doesn't know this word or phrase. Try selecting a single word.</p>
          </div>
        )}
        {state.status === 'error' && (
          <div className="py-2 text-center">
            {state.offline ? <WifiOff size={20} className="mx-auto mb-2 text-ink-3" /> : <RotateCw size={20} className="mx-auto mb-2 text-ink-3" />}
            <p className="text-[13px] text-ink-2">{state.message}</p>
            <button className="btn btn-outline mt-3" onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </button>
          </div>
        )}
      </div>
      {state.status === 'found' && (
        <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
          <a href={state.entry.sourceUrl ?? 'https://dictionaryapi.dev'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink-2">
            {state.entry.sourceName} <ExternalLink size={10} />
          </a>
          <button className={cx('btn h-8', saved ? 'btn-ghost text-accent' : 'btn-accent')} onClick={() => void save()} disabled={saved} data-testid="dict-save">
            {saved ? (
              <>
                <Check size={14} /> In vocabulary
              </>
            ) : (
              <>
                <Plus size={14} /> Save word
              </>
            )}
          </button>
        </div>
      )}
    </Floating>
  );
}

export function ReaderPopovers() {
  const selection = useReader((s) => s.selection);
  const active = useReader((s) => s.activeHighlight);
  const dictionary = useReader((s) => s.dictionary);
  const aiCard = useReader((s) => s.aiCard);
  const doc = useReader((s) => s.doc);
  // Learn once per visit whether the assistant's backend is running (it decides the toolbar's Ask AI button),
  // and prepare the document in the background if the backend has never seen it.
  useEffect(() => {
    if (doc?.format !== 'pdf') return;
    void (async () => {
      if (useAi.getState().health.kind === 'checking') await checkHealth();
      await autoPrepare(doc);
    })();
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {selection && <SelectionToolbar key={selection.text + selection.anchor.top} />}
      {active && <HighlightCard key={active.id} />}
      {dictionary && <DictionaryCard key={dictionary.term + dictionary.anchor.top} />}
      {aiCard && <SelectionAssistant key={aiCard.text + aiCard.anchor.top} req={aiCard} />}
    </>
  );
}
