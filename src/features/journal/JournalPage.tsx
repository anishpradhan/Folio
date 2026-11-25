import { useEffect, useMemo, useRef, useState } from 'react';
import { NotebookPen, Plus, Trash2, ArrowLeft, Check } from 'lucide-react';
import { useLive } from '../../data/useLive';
import { deleteJournal, listDocuments, listJournal, saveJournal } from '../../data/repo';
import type { JournalEntry, JournalKind } from '../../core/types';
import { cx, dayKey, formatDate, parseDayKey } from '../../lib/util';
import { AutoTextarea, EmptyState, Spinner, flash } from '../../components/ui';

export const KINDS: { id: JournalKind; label: string; prompt: string }[] = [
  { id: 'thoughts', label: 'Thoughts', prompt: 'What is this book making you think about?' },
  { id: 'summary', label: 'Chapter summary', prompt: 'In a few sentences, what happened in this chapter?' },
  { id: 'takeaways', label: 'Takeaways', prompt: 'What will you carry with you from this?' },
  { id: 'reflection', label: 'Reflection', prompt: 'How does this connect to your own life?' },
];

function Editor({ entry, onBack }: { entry: JournalEntry; onBack: () => void }) {
  const docs = useLive(listDocuments, ['documents'], []) ?? [];
  const [draft, setDraft] = useState(entry);
  const [state, setState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const first = useRef(true);
  useEffect(() => {
    setDraft(entry);
    first.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  // Autosave after a pause.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setState('dirty');
    const t = setTimeout(async () => {
      setState('saving');
      await saveJournal(draft);
      setState('saved');
    }, 600);
    return () => clearTimeout(t);
  }, [draft]);

  const kind = KINDS.find((k) => k.id === draft.kind)!;
  const patch = (p: Partial<JournalEntry>) => setDraft((d) => ({ ...d, ...p }));
  return (
    <article className="anim-fade" data-testid="journal-editor">
      <div className="mb-6 flex items-center gap-2">
        <button className="icon-btn md:hidden" aria-label="Back to entries" onClick={onBack}>
          <ArrowLeft size={17} />
        </button>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Entry type">
          {KINDS.map((k) => (
            <button key={k.id} role="radio" aria-checked={draft.kind === k.id} onClick={() => patch({ kind: k.id })} className={cx('rounded-full px-3 py-1 text-[12px] transition-colors', draft.kind === k.id ? 'bg-ink text-bg' : 'bg-ink/[0.05] text-ink-2 hover:bg-ink/10')}>
              {k.label}
            </button>
          ))}
        </div>
        <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-ink-3" aria-live="polite">
          {state === 'saved' ? (
            <>
              <Check size={12} /> Saved
            </>
          ) : state === 'saving' ? (
            'Saving…'
          ) : (
            'Editing'
          )}
        </span>
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-[12.5px]">
        <select className="field h-8 w-auto max-w-[280px] py-0 text-[12.5px]" aria-label="Book" value={draft.docId ?? ''} onChange={(e) => patch({ docId: e.target.value || null })}>
          <option value="">Not about a specific book</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
        {draft.docId && (
          <input className="field h-8 w-[90px] py-0 text-[12.5px]" type="number" min={1} placeholder="Page" aria-label="Page" value={draft.page ?? ''} onChange={(e) => patch({ page: e.target.value ? Number(e.target.value) : null })} />
        )}
        <input className="field h-8 w-auto py-0 text-[12.5px]" type="date" aria-label="Date" value={draft.date} onChange={(e) => e.target.value && patch({ date: e.target.value })} />
        <button
          className="icon-btn ml-auto hover:!text-danger"
          aria-label="Delete entry"
          data-tip="Delete entry"
          onClick={async () => {
            await deleteJournal(draft.id);
            flash('Entry deleted', { label: 'Undo', run: () => void saveJournal(draft) });
            onBack();
          }}
        >
          <Trash2 size={15} />
        </button>
      </div>
      <input className="w-full bg-transparent font-display text-[28px] leading-tight font-medium tracking-tight outline-none placeholder:text-ink-3/60" placeholder="Untitled entry" aria-label="Title" value={draft.title} onChange={(e) => patch({ title: e.target.value })} data-testid="journal-title" />
      <AutoTextarea
        minRows={12}
        aria-label="Entry"
        data-testid="journal-body"
        className="mt-4 bg-transparent px-0 font-serif text-[16.5px] leading-[1.8] shadow-none focus:bg-transparent focus:shadow-none"
        placeholder={kind.prompt}
        value={draft.body}
        onChange={(e) => patch({ body: e.target.value })}
      />
    </article>
  );
}

export default function JournalPage() {
  const entries = useLive(listJournal, ['journal'], []);
  const docs = useLive(listDocuments, ['documents'], []);
  const [selected, setSelected] = useState<string | null>(null);
  const [docFilter, setDocFilter] = useState('all');
  const titles = useMemo(() => new Map((docs ?? []).map((d) => [d.id, d.title])), [docs]);

  const list = useMemo(() => (entries ?? []).filter((e) => docFilter === 'all' || (docFilter === 'none' ? !e.docId : e.docId === docFilter)), [entries, docFilter]);
  const months = useMemo(() => {
    const m = new Map<string, JournalEntry[]>();
    list.forEach((e) => {
      const k = e.date.slice(0, 7);
      m.set(k, [...(m.get(k) ?? []), e]);
    });
    return [...m.entries()];
  }, [list]);
  const current = entries?.find((e) => e.id === selected) ?? null;

  const create = async () => {
    const e = await saveJournal({ kind: 'thoughts', date: dayKey(), docId: docFilter !== 'all' && docFilter !== 'none' ? docFilter : null });
    setSelected(e.id);
  };

  return (
    <div className="mx-auto max-w-[1120px] px-5 pt-8 pb-16 sm:px-10 md:pt-12">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow mb-2">Thinking on paper</p>
          <h1 className="font-display text-[32px] leading-tight font-medium tracking-tight">Reading Journal</h1>
        </div>
        <button className="btn btn-primary" onClick={() => void create()} data-testid="journal-new">
          <Plus size={15} /> New entry
        </button>
      </header>

      {!entries ? (
        <div className="grid h-40 place-items-center text-ink-3">
          <Spinner />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<NotebookPen size={22} />}
          title="Begin your reading journal"
          action={
            <button className="btn btn-accent" onClick={() => void create()}>
              <Plus size={15} /> Write the first entry
            </button>
          }
        >
          Record thoughts, chapter summaries, takeaways and reflections — linked to the books that prompted them.
        </EmptyState>
      ) : (
        <div className="grid gap-10 md:grid-cols-[280px_1fr]">
          <aside className={cx('min-w-0', current && 'hidden md:block')}>
            <select className="field mb-4 h-8 py-0 text-[12.5px]" aria-label="Filter by book" value={docFilter} onChange={(e) => setDocFilter(e.target.value)}>
              <option value="all">All entries</option>
              <option value="none">General</option>
              {(docs ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
            {months.map(([month, list]) => (
              <section key={month} className="mb-5">
                <h2 className="eyebrow mb-1.5">{parseDayKey(`${month}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
                <ul>
                  {list.map((e) => (
                    <li key={e.id}>
                      <button onClick={() => setSelected(e.id)} className={cx('block w-full rounded-xl px-3 py-2.5 text-left transition-colors', selected === e.id ? 'bg-ink/[0.06]' : 'hover:bg-ink/[0.035]')} data-testid="journal-entry">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate font-serif text-[14.5px] text-ink">{e.title || <span className="text-ink-3 italic">Untitled</span>}</span>
                          <span className="shrink-0 text-[11px] text-ink-3 tabular-nums">{formatDate(e.date, { day: 'numeric', month: 'short' })}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[12px] text-ink-3">
                          {KINDS.find((k) => k.id === e.kind)?.label}
                          {e.docId && titles.get(e.docId) ? ` · ${titles.get(e.docId)}` : ''}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {!list.length && <p className="text-[13px] text-ink-3">No entries for this filter.</p>}
          </aside>
          <div className={cx('min-w-0', !current && 'hidden md:block')}>
            {current ? (
              <Editor entry={current} onBack={() => setSelected(null)} />
            ) : (
              <div className="grid h-full min-h-[300px] place-items-center rounded-3xl border border-dashed border-line-2 text-center text-[13.5px] text-ink-3">
                <div>
                  <p className="font-serif text-[16px] text-ink-2 italic">Choose an entry, or start a new page.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
