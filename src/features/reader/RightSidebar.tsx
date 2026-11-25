import { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark as BookmarkIcon, Trash2, Highlighter, NotebookPen, Star, Pencil } from 'lucide-react';
import { useReader } from './store';
import { usePrefs, type RightTab } from '../../state/prefs';
import { cx, relativeTime } from '../../lib/util';
import { addNote, deleteBookmark, deleteNote, updateBookmark, updateHighlight, updateNote } from '../../data/repo';
import type { Bookmark, Highlight, HighlightColor, PageNote } from '../../core/types';
import { AutoTextarea, EmptyState, flash } from '../../components/ui';
import { removeHighlight, toggleBookmarkHere } from './actions';
import { locLong, unitWord } from '../../lib/locations';
import { AskTab } from './AskTab';

export const HL_COLORS: { id: HighlightColor; label: string }[] = [
  { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'pink', label: 'Pink' },
  { id: 'purple', label: 'Purple' },
];

/** Textarea that saves on blur and after a pause in typing. */
export function InlineEditor({ value, onSave, placeholder, autoFocus, minRows = 2, className, label }: { value: string; onSave: (v: string) => void; placeholder: string; autoFocus?: boolean; minRows?: number; className?: string; label: string }) {
  const [draft, setDraft] = useState(value);
  const saved = useRef(value);
  const latest = useRef(draft);
  latest.current = draft;
  // Callers pass inline callbacks; keep the newest one in a ref so a parent re-render
  // doesn't restart the save timer (busy views re-render often while you type).
  const save = useRef(onSave);
  save.current = onSave;
  useEffect(() => {
    setDraft(value);
    saved.current = value;
  }, [value]);
  useEffect(() => {
    if (draft === saved.current) return;
    const t = setTimeout(() => {
      saved.current = draft;
      save.current(draft);
    }, 700);
    return () => clearTimeout(t);
  }, [draft]);
  // Closing the card (Escape, click elsewhere, navigating away) must never lose typed text.
  useEffect(
    () => () => {
      if (latest.current !== saved.current) save.current(latest.current);
    },
    [],
  );
  return (
    <AutoTextarea
      aria-label={label}
      autoFocus={autoFocus}
      minRows={minRows}
      value={draft}
      placeholder={placeholder}
      className={cx('text-[13px]', className)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== saved.current) {
          saved.current = draft;
          save.current(draft);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
        e.stopPropagation();
      }}
    />
  );
}

const jump = (page: number, y?: number, highlightId?: string, offset?: number) => {
  const st = useReader.getState();
  st.nav?.goTo(page, y !== undefined ? { y } : offset !== undefined ? { offset } : undefined);
  if (highlightId) {
    st.set({ flashHighlight: highlightId });
    setTimeout(() => useReader.getState().flashHighlight === highlightId && useReader.getState().set({ flashHighlight: null }), 3400);
  }
};

/* ============================== Highlights ============================== */

function HighlightItem({ h }: { h: Highlight }) {
  const [editing, setEditing] = useState(false);
  return (
    <li className={cx('group relative rounded-xl px-3 py-3 transition-colors hover:bg-ink/[0.035]', `hl-${h.color}`)} data-testid="sidebar-highlight">
      <button className="block w-full text-left" onClick={() => jump(h.page, h.rects[0]?.y, h.id)}>
        <div className="flex gap-3">
          <span className="mt-1 w-[3px] shrink-0 self-stretch rounded-full" style={{ background: 'var(--hl)' }} />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-5 font-serif text-[13.5px] leading-relaxed text-ink">{h.text}</p>
            {h.note && !editing && <p className="mt-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{h.note}</p>}
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-3">
              {h.important && <Star size={11} className="fill-accent text-accent" />}
              {locLong(useReader.getState().doc, h.page)} · {relativeTime(h.createdAt)}
            </p>
          </div>
        </div>
      </button>
      {editing && (
        <div className="mt-2 pl-[15px]">
          <InlineEditor label="Highlight note" autoFocus value={h.note} placeholder="Write a note…" onSave={(v) => void updateHighlight(h.id, { note: v })} />
        </div>
      )}
      <div className="absolute top-2 right-2 flex gap-0.5 rounded-lg bg-surface/90 opacity-0 shadow-soft transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <button className="icon-btn h-7 w-7" aria-label={h.important ? 'Unmark important' : 'Mark important'} data-tip={h.important ? 'Important' : 'Mark as important'} onClick={() => void updateHighlight(h.id, { important: !h.important })}>
          <Star size={13} className={h.important ? 'fill-accent text-accent' : ''} />
        </button>
        <button className="icon-btn h-7 w-7" aria-label="Edit note" data-tip={h.note ? 'Edit note' : 'Add note'} onClick={() => setEditing(!editing)}>
          <Pencil size={13} />
        </button>
        <button className="icon-btn h-7 w-7" aria-label="Delete highlight" data-tip="Delete" onClick={() => void removeHighlight(h)}>
          <Trash2 size={13} />
        </button>
      </div>
    </li>
  );
}

function HighlightsTab() {
  const highlights = useReader((s) => s.highlights);
  const [color, setColor] = useState<HighlightColor | 'all'>('all');
  const sorted = useMemo(
    () => highlights.filter((h) => color === 'all' || h.color === color).sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0)),
    [highlights, color],
  );
  if (!highlights.length)
    return (
      <EmptyState icon={<Highlighter size={20} />} title="No highlights yet">
        Select any passage in the document and choose a colour to keep it here.
      </EmptyState>
    );
  return (
    <>
      <div className="flex items-center gap-1.5 px-4 pb-2" role="radiogroup" aria-label="Filter by colour">
        <button role="radio" aria-checked={color === 'all'} onClick={() => setColor('all')} className={cx('rounded-full px-2.5 py-0.5 text-[11.5px]', color === 'all' ? 'bg-ink text-bg' : 'text-ink-3 hover:text-ink')}>
          All {highlights.length}
        </button>
        {HL_COLORS.filter((c) => highlights.some((h) => h.color === c.id)).map((c) => (
          <button
            key={c.id}
            role="radio"
            aria-checked={color === c.id}
            aria-label={c.label}
            data-tip={c.label}
            onClick={() => setColor(color === c.id ? 'all' : c.id)}
            className={cx('h-4 w-4 rounded-full transition-transform', `hl-${c.id}`, color === c.id && 'ring-2 ring-ink/40 ring-offset-1 ring-offset-bg')}
            style={{ background: 'var(--hl)' }}
          />
        ))}
      </div>
      <ul className="px-2 pb-8">
        {sorted.map((h) => (
          <HighlightItem key={h.id} h={h} />
        ))}
      </ul>
    </>
  );
}

/* ============================== Bookmarks ============================== */

function BookmarkItem({ b }: { b: Bookmark }) {
  const [noteOpen, setNoteOpen] = useState(!!b.note);
  const [title, setTitle] = useState(b.title);
  useEffect(() => setTitle(b.title), [b.title]);
  return (
    <li className="group rounded-xl px-3 py-2.5 transition-colors hover:bg-ink/[0.035]" data-testid="sidebar-bookmark">
      <div className="flex items-start gap-2.5">
        <button className="mt-1 text-accent" aria-label={`Go to ${locLong(useReader.getState().doc, b.page)}`} onClick={() => jump(b.page, undefined, undefined, b.offset)}>
          <BookmarkIcon size={15} className="fill-accent" />
        </button>
        <div className="min-w-0 flex-1">
          <input
            className="w-full rounded bg-transparent font-serif text-[14px] text-ink outline-none placeholder:text-ink-3 focus:bg-surface focus:px-1.5"
            value={title}
            placeholder={locLong(useReader.getState().doc, b.page)}
            aria-label="Bookmark title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== b.title && void updateBookmark(b.id, { title: title.trim() })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          <button className="text-[11px] text-ink-3 hover:text-ink-2" onClick={() => jump(b.page, undefined, undefined, b.offset)}>
            {locLong(useReader.getState().doc, b.page)} · {relativeTime(b.createdAt)}
          </button>
          {noteOpen ? (
            <div className="mt-2">
              <InlineEditor label="Bookmark note" value={b.note} placeholder="Why this page matters…" autoFocus={!b.note} onSave={(v) => void updateBookmark(b.id, { note: v })} />
            </div>
          ) : (
            <button className="mt-1 block text-[12px] text-ink-3 opacity-0 group-hover:opacity-100 hover:text-accent focus:opacity-100" onClick={() => setNoteOpen(true)}>
              + Add a note
            </button>
          )}
        </div>
        <button className="icon-btn h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label="Remove bookmark" data-tip="Remove" onClick={() => void deleteBookmark(b.id)}>
          <Trash2 size={13} />
        </button>
      </div>
    </li>
  );
}

function BookmarksTab() {
  const bookmarks = useReader((s) => s.bookmarks);
  const page = useReader((s) => s.page);
  const doc = useReader((s) => s.doc);
  const has = bookmarks.some((b) => b.page === page);
  const unit = unitWord(doc);
  return (
    <>
      <div className="px-4 pb-3">
        <button className="btn btn-outline w-full justify-center" onClick={() => void toggleBookmarkHere()} data-testid="sidebar-bookmark-toggle">
          <BookmarkIcon size={14} /> {has ? `Remove bookmark on this ${unit}` : `Bookmark this ${unit}`}
        </button>
      </div>
      {bookmarks.length ? (
        <ul className="px-2 pb-8">
          {bookmarks.map((b) => (
            <BookmarkItem key={b.id} b={b} />
          ))}
        </ul>
      ) : (
        <EmptyState icon={<BookmarkIcon size={20} />} title="No bookmarks">
          Mark {unit}s you want to return to. Press <span className="kbd">{usePrefs.getState().shortcuts.bookmark || 'B'}</span> anytime.
        </EmptyState>
      )}
    </>
  );
}

/* ============================== Notes ============================== */

function NoteItem({ n }: { n: PageNote }) {
  return (
    <li className="group rounded-xl px-3 py-2.5 transition-colors hover:bg-ink/[0.035]" data-testid="sidebar-note">
      <div className="mb-1.5 flex items-center justify-between">
        <button className="text-[11px] font-medium text-ink-3 hover:text-accent" onClick={() => jump(n.page)}>
          {locLong(useReader.getState().doc, n.page)}
        </button>
        <span className="flex items-center gap-1 text-[11px] text-ink-3">
          {n.updatedAt - n.createdAt > 2000 ? `Edited ${relativeTime(n.updatedAt).toLowerCase()}` : relativeTime(n.createdAt)}
          <button className="icon-btn h-6 w-6 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label="Delete note" data-tip="Delete" onClick={() => void deleteNote(n.id)}>
            <Trash2 size={12} />
          </button>
        </span>
      </div>
      <InlineEditor label="Note" value={n.body} placeholder="Empty note" minRows={1} className="bg-transparent shadow-none focus:shadow-[inset_0_0_0_1px_var(--line-2)]" onSave={(v) => void updateNote(n.id, v)} />
    </li>
  );
}

function NotesTab() {
  const doc = useReader((s) => s.doc)!;
  const notes = useReader((s) => s.notes);
  const page = useReader((s) => s.page);
  const [draft, setDraft] = useState('');
  const sorted = useMemo(() => [...notes].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt), [notes]);
  const save = async () => {
    if (!draft.trim()) return;
    await addNote(doc.id, page, draft.trim());
    setDraft('');
    flash(`Note saved to page ${page}`);
  };
  return (
    <>
      <div className="px-4 pb-4">
        <AutoTextarea
          aria-label={`New note for page ${page}`}
          data-testid="page-note-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`A thought about page ${page}…`}
          className="text-[13px]"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-ink-3">Ctrl + Enter to save</span>
          <button className="btn btn-primary h-8" disabled={!draft.trim()} onClick={() => void save()} data-testid="page-note-save">
            Add note
          </button>
        </div>
      </div>
      {sorted.length ? (
        <ul className="px-2 pb-8">
          {sorted.map((n) => (
            <NoteItem key={n.id} n={n} />
          ))}
        </ul>
      ) : (
        <EmptyState icon={<NotebookPen size={20} />} title="No page notes">
          Notes you write here are pinned to the page you’re reading.
        </EmptyState>
      )}
    </>
  );
}

/* ============================== Sidebar ============================== */

const TABS: { id: RightTab; label: string }[] = [
  { id: 'highlights', label: 'Highlights' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'notes', label: 'Notes' },
  { id: 'ask', label: 'Ask' },
];

export function RightSidebar({ overlay }: { overlay: boolean }) {
  const focus = useReader((s) => s.focus);
  const counts: Record<RightTab, number> = {
    highlights: useReader((s) => s.highlights.length),
    bookmarks: useReader((s) => s.bookmarks.length),
    notes: useReader((s) => s.notes.length),
    ask: 0,
  };
  const open = usePrefs((s) => s.rightOpen) && !focus;
  const tab = usePrefs((s) => s.rightTab);
  const set = usePrefs((s) => s.set);
  if (!open) return null;
  return (
    <aside
      className={cx('flex w-[330px] shrink-0 flex-col border-l border-line bg-bg', overlay ? 'absolute inset-y-0 right-0 z-30 shadow-pop anim-fade' : 'relative')}
      aria-label="Notebook"
      data-testid="right-sidebar"
    >
      <div role="tablist" className="flex gap-5 border-b border-line px-5 pt-3">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className="tab pb-2.5" onClick={() => set({ rightTab: t.id })} data-testid={`tab-${t.id}`}>
            {t.label}
            {counts[t.id] > 0 && <span className="ml-1.5 text-[11px] text-ink-3 tabular-nums">{counts[t.id]}</span>}
          </button>
        ))}
      </div>
      {tab === 'ask' ? (
        // The chat scrolls its own message list so the question box stays at the bottom.
        <div className="flex min-h-0 flex-1 flex-col pt-3" role="tabpanel" aria-label="Ask">
          <AskTab />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pt-3">
          {tab === 'highlights' && <HighlightsTab />}
          {tab === 'bookmarks' && <BookmarksTab />}
          {tab === 'notes' && <NotesTab />}
        </div>
      )}
    </aside>
  );
}
