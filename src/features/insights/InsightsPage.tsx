import { useMemo, useState } from 'react';
import { Search, Sparkles, Star, Trash2, ArrowUpRight, Bookmark, NotebookPen, Highlighter, Download, X } from 'lucide-react';
import { useLive } from '../../data/useLive';
import { deleteBookmark, deleteHighlight, deleteNote, listBookmarks, listDocuments, listHighlights, listNotes, restoreHighlight, updateHighlight } from '../../data/repo';
import type { DocumentRecord, HighlightColor, Highlight } from '../../core/types';
import { navigate, readerPath } from '../../lib/router';
import { cx, formatDate, relativeTime } from '../../lib/util';
import { EmptyState, Segmented, Spinner, flash } from '../../components/ui';
import { HL_COLORS } from '../reader/RightSidebar';
import { locLong, locShort } from '../../lib/locations';
import { BookCover } from '../library/BookCover';

type Kind = 'highlight' | 'bookmark' | 'note';
type Tab = 'all' | 'highlights' | 'bookmarks' | 'notes' | 'important';

interface Item {
  key: string;
  kind: Kind;
  id: string;
  docId: string;
  page: number;
  /** Passage (highlights) or title (bookmarks) or body (notes). */
  text: string;
  note: string;
  color?: HighlightColor;
  important?: boolean;
  createdAt: number;
  updatedAt: number;
  highlight?: Highlight;
}

const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'highlights', label: 'Highlights' },
  { value: 'bookmarks', label: 'Bookmarks' },
  { value: 'notes', label: 'Notes' },
  { value: 'important', label: 'Important' },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function toMarkdown(items: Item[], docs: Map<string, DocumentRecord>) {
  const byDoc = new Map<string, Item[]>();
  items.forEach((i) => byDoc.set(i.docId, [...(byDoc.get(i.docId) ?? []), i]));
  let md = `# My Insights\n\n_Exported from Folio on ${new Date().toLocaleDateString()}_\n`;
  for (const [docId, list] of byDoc) {
    const d = docs.get(docId);
    md += `\n## ${d?.title ?? 'Unknown document'}${d?.author ? ` — ${d.author}` : ''}\n\n`;
    for (const i of [...list].sort((a, b) => a.page - b.page)) {
      if (i.kind === 'highlight') md += `> ${i.text}\n\n— p. ${i.page}${i.important ? ' ★' : ''}\n${i.note ? `\n${i.note}\n` : ''}\n`;
      else if (i.kind === 'bookmark') md += `- 🔖 **p. ${i.page}** ${i.text}${i.note ? ` — ${i.note}` : ''}\n`;
      else md += `- 📝 **p. ${i.page}** ${i.text}\n`;
    }
  }
  return md;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ItemRow({ item, doc, showDoc }: { item: Item; doc?: DocumentRecord; showDoc: boolean }) {
  const open = () => navigate(readerPath(item.docId, item.page, item.kind === 'highlight' ? item.id : undefined));
  const remove = async () => {
    if (item.kind === 'highlight' && item.highlight) {
      const h = item.highlight;
      await deleteHighlight(h.id);
      flash('Highlight removed', { label: 'Undo', run: () => void restoreHighlight(h) });
    } else if (item.kind === 'bookmark') await deleteBookmark(item.id);
    else await deleteNote(item.id);
  };
  const Icon = item.kind === 'highlight' ? Highlighter : item.kind === 'bookmark' ? Bookmark : NotebookPen;
  return (
    <li className={cx('group relative flex gap-4 py-5', item.color && `hl-${item.color}`)} data-testid="insight-item">
      <div className="flex w-5 shrink-0 flex-col items-center pt-1">
        {item.kind === 'highlight' ? <span className="h-full w-[3px] rounded-full" style={{ background: 'var(--hl)' }} /> : <Icon size={15} className="text-ink-3" />}
      </div>
      <div className="min-w-0 flex-1">
        {item.kind === 'highlight' ? (
          <blockquote className="font-serif text-[15.5px] leading-[1.65] text-ink">{item.text}</blockquote>
        ) : item.kind === 'bookmark' ? (
          <p className="font-serif text-[15.5px] text-ink">{item.text || <span className="text-ink-3 italic">Bookmarked · {locLong(doc, item.page)}</span>}</p>
        ) : (
          <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-ink">{item.text}</p>
        )}
        {item.note && <p className="mt-2 border-l-2 border-line-2 pl-3 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{item.note}</p>}
        <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
          {item.important && <Star size={12} className="fill-accent text-accent" />}
          {showDoc && doc && <span className="font-medium text-ink-2">{doc.title}</span>}
          {showDoc && <span aria-hidden>·</span>}
          <span>{locShort(doc, item.page)}</span>
          <span aria-hidden>·</span>
          <span title={new Date(item.createdAt).toLocaleString()}>{formatDate(item.createdAt)}</span>
        </p>
      </div>
      <div className="flex shrink-0 items-start gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {item.kind === 'highlight' && (
          <button className={cx('icon-btn h-8 w-8', item.important && 'is-on')} aria-label={item.important ? 'Unmark important' : 'Mark important'} data-tip={item.important ? 'Important' : 'Mark as important'} onClick={() => void updateHighlight(item.id, { important: !item.important })}>
            <Star size={15} className={item.important ? 'fill-current' : ''} />
          </button>
        )}
        <button className="icon-btn h-8 w-8 hover:!text-danger" aria-label="Delete" data-tip="Delete" onClick={() => void remove()}>
          <Trash2 size={15} />
        </button>
        <button className="btn btn-outline h-8 px-3 text-[12px]" onClick={open} data-testid="insight-jump">
          Open <ArrowUpRight size={13} />
        </button>
      </div>
    </li>
  );
}

export default function InsightsPage() {
  const highlights = useLive(() => listHighlights(), ['highlights'], []);
  const bookmarks = useLive(() => listBookmarks(), ['bookmarks'], []);
  const notes = useLive(() => listNotes(), ['notes'], []);
  const docsList = useLive(listDocuments, ['documents'], []);
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [docFilter, setDocFilter] = useState('all');
  const [color, setColor] = useState<HighlightColor | 'all'>('all');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'document'>('newest');

  const docs = useMemo(() => new Map((docsList ?? []).map((d) => [d.id, d])), [docsList]);

  const items = useMemo<Item[]>(() => {
    if (!highlights || !bookmarks || !notes) return [];
    const live = (id: string) => docs.has(id);
    return [
      ...highlights.filter((h) => live(h.docId)).map<Item>((h) => ({ key: `h${h.id}`, kind: 'highlight', id: h.id, docId: h.docId, page: h.page, text: h.text, note: h.note, color: h.color, important: h.important, createdAt: h.createdAt, updatedAt: h.updatedAt, highlight: h })),
      ...bookmarks.filter((b) => live(b.docId)).map<Item>((b) => ({ key: `b${b.id}`, kind: 'bookmark', id: b.id, docId: b.docId, page: b.page, text: b.title, note: b.note, createdAt: b.createdAt, updatedAt: b.updatedAt })),
      ...notes.filter((n) => live(n.docId)).map<Item>((n) => ({ key: `n${n.id}`, kind: 'note', id: n.id, docId: n.docId, page: n.page, text: n.body, note: '', createdAt: n.createdAt, updatedAt: n.updatedAt })),
    ];
  }, [highlights, bookmarks, notes, docs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = items.filter((i) => {
      if (tab === 'highlights' && i.kind !== 'highlight') return false;
      if (tab === 'bookmarks' && i.kind !== 'bookmark') return false;
      // "Notes" gathers every written note: page notes plus notes on passages and bookmarks.
      if (tab === 'notes' && !(i.kind === 'note' || i.note)) return false;
      if (tab === 'important' && !i.important) return false;
      if (docFilter !== 'all' && i.docId !== docFilter) return false;
      if (color !== 'all' && i.color !== color) return false;
      if (q && !`${i.text} ${i.note} ${docs.get(i.docId)?.title ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    list = list.sort((a, b) => (sort === 'oldest' ? a.createdAt - b.createdAt : sort === 'newest' ? b.createdAt - a.createdAt : (docs.get(a.docId)?.title ?? '').localeCompare(docs.get(b.docId)?.title ?? '') || a.page - b.page));
    return list;
  }, [items, tab, docFilter, color, query, sort, docs]);

  const grouped = sort === 'document';
  const groups = useMemo(() => {
    if (!grouped) return null;
    const m = new Map<string, Item[]>();
    filtered.forEach((i) => m.set(i.docId, [...(m.get(i.docId) ?? []), i]));
    return [...m.entries()];
  }, [filtered, grouped]);

  const counts = {
    highlights: items.filter((i) => i.kind === 'highlight').length,
    bookmarks: items.filter((i) => i.kind === 'bookmark').length,
    notes: items.filter((i) => i.kind === 'note' || i.note).length,
  };
  const loading = !highlights || !bookmarks || !notes || !docsList;
  const docsWithItems = [...new Set(items.map((i) => i.docId))].map((id) => docs.get(id)).filter(Boolean) as DocumentRecord[];

  return (
    <div className="mx-auto max-w-[920px] px-5 pt-8 pb-16 sm:px-10 md:pt-12">
      <header className="mb-8">
        <p className="eyebrow mb-2">Everything you’ve kept</p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="font-display text-[32px] leading-tight font-medium tracking-tight">My Insights</h1>
          {filtered.length > 0 && (
            <button className="btn btn-ghost" onClick={() => download(`folio-insights-${new Date().toISOString().slice(0, 10)}.md`, toMarkdown(filtered, docs))}>
              <Download size={15} /> Export Markdown
            </button>
          )}
        </div>
        {!loading && items.length > 0 && (
          <p className="mt-1.5 font-serif text-[15px] text-ink-2 italic">
            {plural(counts.highlights, 'highlight')}, {plural(counts.bookmarks, 'bookmark')} and {plural(counts.notes, 'note')} across {plural(docsWithItems.length, 'book')}.
          </p>
        )}
      </header>

      {loading ? (
        <div className="grid h-40 place-items-center text-ink-3">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={<Sparkles size={22} />} title="Nothing saved yet">
          As you read, highlight passages, bookmark pages and jot notes. They’ll gather here, ready to revisit.
        </EmptyState>
      ) : (
        <>
          <div className="sticky top-0 z-10 -mx-2 mb-2 grid gap-3 bg-bg/95 px-2 pt-2 pb-3 backdrop-blur md:top-0">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented label="Kind" value={tab} onChange={setTab} options={TABS} size="sm" />
              <span className="flex-1" />
              <label className="relative w-full sm:w-[240px]">
                <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" />
                <input className="field h-8 rounded-full pr-8 pl-8 text-[12.5px]" placeholder="Search your insights" aria-label="Search insights" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="insights-search" />
                {query && (
                  <button className="absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-3" aria-label="Clear" onClick={() => setQuery('')}>
                    <X size={13} />
                  </button>
                )}
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
              <select className="field h-8 w-auto max-w-[260px] py-0 text-[12.5px]" value={docFilter} onChange={(e) => setDocFilter(e.target.value)} aria-label="Filter by document">
                <option value="all">All documents</option>
                {docsWithItems.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Filter by colour">
                {HL_COLORS.map((c) => (
                  <button
                    key={c.id}
                    role="radio"
                    aria-checked={color === c.id}
                    aria-label={c.label}
                    data-tip={c.label}
                    onClick={() => setColor(color === c.id ? 'all' : c.id)}
                    className={cx('h-4 w-4 rounded-full', `hl-${c.id}`, color === c.id && 'ring-2 ring-ink/40 ring-offset-2 ring-offset-bg')}
                    style={{ background: 'var(--hl)' }}
                  />
                ))}
              </div>
              <span className="flex-1" />
              <select className="field h-8 w-auto py-0 text-[12.5px]" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="document">By book & page</option>
              </select>
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState icon={<Search size={20} />} title="No matches">
              Try a different word, colour or document.
            </EmptyState>
          ) : groups ? (
            groups.map(([docId, list]) => {
              const d = docs.get(docId);
              return (
                <section key={docId} className="mt-6">
                  <div className="flex items-center gap-3 border-b border-line pb-3">
                    {d && <BookCover doc={d} className="w-[34px]" />}
                    <div>
                      <h2 className="font-display text-[17px] font-medium">{d?.title}</h2>
                      <p className="text-[12px] text-ink-3">
                        {list.length} saved · last {relativeTime(Math.max(...list.map((i) => i.updatedAt))).toLowerCase()}
                      </p>
                    </div>
                  </div>
                  <ul className="divide-y divide-line">
                    {list.map((i) => (
                      <ItemRow key={i.key} item={i} doc={d} showDoc={false} />
                    ))}
                  </ul>
                </section>
              );
            })
          ) : (
            <ul className="divide-y divide-line">
              {filtered.map((i) => (
                <ItemRow key={i.key} item={i} doc={docs.get(i.docId)} showDoc />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
