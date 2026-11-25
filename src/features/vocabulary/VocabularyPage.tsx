import { useMemo, useState } from 'react';
import { Languages, Volume2, ArrowUpRight, Trash2, Check, Search, ChevronDown, Layers, X, RotateCcw } from 'lucide-react';
import { useLive } from '../../data/useLive';
import { deleteVocabulary, listDocuments, listVocabulary, updateVocabulary } from '../../data/repo';
import type { DocumentRecord, VocabularyEntry } from '../../core/types';
import { locShort } from '../../lib/locations';
import { navigate, readerPath } from '../../lib/router';
import { cx, formatDate } from '../../lib/util';
import { EmptyState, Segmented, Spinner, flash } from '../../components/ui';

function play(url: string | null) {
  if (!url) return;
  void new Audio(url).play().catch(() => flash('Audio could not be played'));
}

/** Highlight the headword inside its context sentence. */
function Context({ text, word }: { text: string; word: string }) {
  const i = text.toLowerCase().indexOf(word.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <b className="font-semibold text-ink not-italic">{text.slice(i, i + word.length)}</b>
      {text.slice(i + word.length)}
    </>
  );
}

function WordRow({ v, doc }: { v: VocabularyEntry; doc?: DocumentRecord }) {
  const docTitle = doc?.title;
  const [open, setOpen] = useState(false);
  const first = v.meanings[0];
  return (
    <li className="group py-5" data-testid="vocab-item">
      <div className="flex items-start gap-4">
        <button
          role="checkbox"
          aria-checked={v.learned}
          aria-label={v.learned ? `Mark ${v.word} as still learning` : `Mark ${v.word} as learned`}
          data-tip={v.learned ? 'Learned' : 'Mark as learned'}
          onClick={() => void updateVocabulary(v.id, { learned: !v.learned })}
          className={cx('mt-1.5 grid h-5 w-5 shrink-0 place-items-center rounded-full transition-colors', v.learned ? 'bg-accent text-accent-ink' : 'ring-1.5 ring-line-2 ring-inset hover:ring-accent')}
          style={v.learned ? undefined : { boxShadow: 'inset 0 0 0 1.5px var(--line-2)' }}
        >
          {v.learned && <Check size={12} strokeWidth={3} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h3 className={cx('font-display text-[22px] leading-tight font-medium tracking-tight', v.learned && 'text-ink-2')}>{v.word}</h3>
            {v.phonetic && <span className="font-serif text-[14px] text-ink-3">{v.phonetic}</span>}
            {v.audioUrl && (
              <button className="icon-btn h-7 w-7 self-center" aria-label="Pronounce" data-tip="Pronounce" onClick={() => play(v.audioUrl)}>
                <Volume2 size={14} />
              </button>
            )}
          </div>
          {first && (
            <p className="mt-1 text-[14px] leading-relaxed text-ink">
              <span className="mr-2 text-[11px] font-semibold tracking-wider text-accent uppercase">{first.partOfSpeech}</span>
              {first.definitions[0]?.definition}
            </p>
          )}
          {v.context && (
            <p className="mt-2 font-serif text-[14px] leading-relaxed text-ink-2 italic">
              “<Context text={v.context} word={v.word} />”
            </p>
          )}
          {open && (
            <div className="mt-3 space-y-3 anim-fade">
              {v.meanings.map((m) => (
                <div key={m.partOfSpeech}>
                  <div className="eyebrow mb-1 text-accent">{m.partOfSpeech}</div>
                  <ol className="list-decimal space-y-1 pl-5 text-[13.5px] text-ink-2">
                    {m.definitions.map((d, i) => (
                      <li key={i}>
                        {d.definition}
                        {d.example && <span className="block font-serif text-ink-3 italic">“{d.example}”</span>}
                      </li>
                    ))}
                  </ol>
                  {m.synonyms.length > 0 && <p className="mt-1 text-[12.5px] text-ink-3">Similar: {m.synonyms.join(', ')}</p>}
                </div>
              ))}
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
            {docTitle && v.docId && (
              <button className="inline-flex items-center gap-1 font-medium text-ink-2 hover:text-accent" onClick={() => navigate(readerPath(v.docId!, v.page ?? undefined))} data-testid="vocab-source">
                {docTitle}
                {v.page ? ` · ${locShort(doc, v.page)}` : ''} <ArrowUpRight size={12} />
              </button>
            )}
            <span>Saved {formatDate(v.createdAt)}</span>
            {(v.meanings.length > 1 || (first?.definitions.length ?? 0) > 1) && (
              <button className="inline-flex items-center gap-0.5 hover:text-ink-2" onClick={() => setOpen(!open)} aria-expanded={open}>
                {open ? 'Less' : 'All definitions'} <ChevronDown size={12} className={cx('transition-transform', open && 'rotate-180')} />
              </button>
            )}
          </div>
        </div>
        <button className="icon-btn h-8 w-8 opacity-0 group-hover:opacity-100 hover:!text-danger focus:opacity-100" aria-label={`Delete ${v.word}`} data-tip="Remove" onClick={() => void deleteVocabulary(v.id)}>
          <Trash2 size={15} />
        </button>
      </div>
    </li>
  );
}

function Review({ words, onClose }: { words: VocabularyEntry[]; onClose: () => void }) {
  const deck = useMemo(() => [...words].sort(() => Math.random() - 0.5), [words]);
  const [i, setI] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [known, setKnown] = useState(0);
  const v = deck[i];
  const next = async (learned: boolean) => {
    if (learned) {
      await updateVocabulary(v.id, { learned: true });
      setKnown((k) => k + 1);
    }
    setRevealed(false);
    setI(i + 1);
  };
  return (
    <div className="mx-auto mb-10 max-w-[560px] rounded-3xl bg-surface p-8 shadow-pop anim-rise">
      <div className="mb-6 flex items-center justify-between text-[12px] text-ink-3">
        <span className="eyebrow">Review · {Math.min(i + 1, deck.length)} of {deck.length}</span>
        <button className="icon-btn h-7 w-7" aria-label="End review" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {v ? (
        <div className="text-center">
          <div className="font-display text-[38px] font-medium tracking-tight">{v.word}</div>
          {v.phonetic && <div className="mt-1 font-serif text-[15px] text-ink-3">{v.phonetic}</div>}
          {v.context && !revealed && <p className="mx-auto mt-5 max-w-[42ch] font-serif text-[14.5px] leading-relaxed text-ink-2 italic">“{v.context}”</p>}
          {revealed ? (
            <div className="mt-6 anim-fade">
              <p className="text-[15px] leading-relaxed">
                <span className="mr-2 text-[11px] font-semibold tracking-wider text-accent uppercase">{v.meanings[0]?.partOfSpeech}</span>
                {v.meanings[0]?.definitions[0]?.definition}
              </p>
              <div className="mt-7 flex justify-center gap-3">
                <button className="btn btn-outline" onClick={() => void next(false)}>
                  <RotateCcw size={14} /> Still learning
                </button>
                <button className="btn btn-accent" onClick={() => void next(true)}>
                  <Check size={14} /> I know this
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn-primary mt-7" onClick={() => setRevealed(true)}>
              Show meaning
            </button>
          )}
        </div>
      ) : (
        <div className="py-6 text-center">
          <div className="font-display text-[24px]">Review complete</div>
          <p className="mt-1 text-[13.5px] text-ink-3">
            {known} of {deck.length} marked as learned.
          </p>
          <button className="btn btn-primary mt-5" onClick={onClose}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}

export default function VocabularyPage() {
  const words = useLive(listVocabulary, ['vocabulary'], []);
  const docs = useLive(listDocuments, ['documents'], []);
  const [filter, setFilter] = useState<'learning' | 'learned' | 'all'>('all');
  const [query, setQuery] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const byId = useMemo(() => new Map((docs ?? []).map((d) => [d.id, d])), [docs]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (words ?? []).filter((w) => (filter === 'all' || (filter === 'learned' ? w.learned : !w.learned)) && (!q || w.word.toLowerCase().includes(q) || w.meanings.some((m) => m.definitions.some((d) => d.definition.toLowerCase().includes(q)))));
  }, [words, filter, query]);
  const learning = (words ?? []).filter((w) => !w.learned);

  return (
    <div className="mx-auto max-w-[860px] px-5 pt-8 pb-16 sm:px-10 md:pt-12">
      <header className="mb-8">
        <p className="eyebrow mb-2">Words found while reading</p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="font-display text-[32px] leading-tight font-medium tracking-tight">Vocabulary</h1>
          {learning.length > 0 && !reviewing && (
            <button className="btn btn-accent" onClick={() => setReviewing(true)}>
              <Layers size={15} /> Review {learning.length} {learning.length === 1 ? 'word' : 'words'}
            </button>
          )}
        </div>
        {words && words.length > 0 && (
          <p className="mt-1.5 font-serif text-[15px] text-ink-2 italic">
            {words.length} saved · {words.length - learning.length} learned
          </p>
        )}
      </header>

      {reviewing && <Review words={learning} onClose={() => setReviewing(false)} />}

      {!words ? (
        <div className="grid h-40 place-items-center text-ink-3">
          <Spinner />
        </div>
      ) : words.length === 0 ? (
        <EmptyState icon={<Languages size={22} />} title="Your word notebook is empty">
          Select a word while reading and choose <b className="font-semibold text-ink-2">Define</b>. Save it, and it will appear here with the sentence you found it in.
        </EmptyState>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <Segmented
              label="Filter"
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'learning', label: 'Learning' },
                { value: 'learned', label: 'Learned' },
              ]}
            />
            <span className="flex-1" />
            <label className="relative w-full sm:w-[220px]">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" />
              <input className="field h-8 rounded-full pl-8 text-[12.5px]" placeholder="Find a word" aria-label="Find a word" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          </div>
          {list.length ? (
            <ul className="divide-y divide-line">
              {list.map((v) => (
                <WordRow key={v.id} v={v} doc={v.docId ? byId.get(v.docId) : undefined} />
              ))}
            </ul>
          ) : (
            <p className="py-10 text-center text-[13.5px] text-ink-3">No words here yet.</p>
          )}
        </>
      )}
    </div>
  );
}
