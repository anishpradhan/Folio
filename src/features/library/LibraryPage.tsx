import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Upload as UploadIcon, Heart, MoreHorizontal, BookOpen, Pencil, Trash2, FolderPlus, X, AlertCircle, ArrowDownWideNarrow, FileUp, Link2, RotateCw } from 'lucide-react';
import { useLive } from '../../data/useLive';
import { listCollections, listDays, listDocuments, purgeDocument, restoreDocument, softDeleteDocument, updateDocument } from '../../data/repo';
import type { Collection, DocumentRecord } from '../../core/types';
import { ACCEPT_ATTR } from '../../core/formats';
import { navigate, readerPath } from '../../lib/router';
import { cx, dayKey, formatBytes, relativeTime } from '../../lib/util';
import { usePrefs, type LibrarySort } from '../../state/prefs';
import { useUploads, stageLabel } from '../../state/uploads';
import { Dialog, EmptyState, Menu, Spinner, flash, usePopover } from '../../components/ui';
import { BookCover } from './BookCover';
import { normalizeLink } from '../../core/linkImport';

export const progressOf = (d: DocumentRecord) => (d.completedAt ? 100 : Math.round((Math.min(d.furthestPage, d.pageCount) / Math.max(1, d.pageCount)) * 100));

const SORTS: { value: LibrarySort; label: string }[] = [
  { value: 'opened', label: 'Recently opened' },
  { value: 'added', label: 'Recently added' },
  { value: 'title', label: 'Title' },
  { value: 'progress', label: 'Reading progress' },
];

function sortDocs(docs: DocumentRecord[], sort: LibrarySort) {
  const list = [...docs];
  switch (sort) {
    case 'opened':
      return list.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.addedAt - a.addedAt);
    case 'added':
      return list.sort((a, b) => b.addedAt - a.addedAt);
    case 'title':
      return list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
    case 'progress':
      return list.sort((a, b) => progressOf(b) - progressOf(a) || (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
  }
}

function matches(d: DocumentRecord, q: string) {
  const hay = `${d.title} ${d.author} ${d.fileName} ${d.subject} ${d.keywords} ${d.creator}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Reading late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/* ------------------------------------------------------------------ */

function openDoc(d: DocumentRecord) {
  navigate(readerPath(d.id));
}

function removeDoc(d: DocumentRecord) {
  void softDeleteDocument(d.id);
  let undone = false;
  flash(
    `Removed “${d.title}”`,
    {
      label: 'Undo',
      run: () => {
        undone = true;
        void restoreDocument(d.id);
      },
    },
    6000,
  );
  setTimeout(() => !undone && void purgeDocument(d.id), 6500);
}

function BookMenu({ doc, onEdit, anchorRef, anchor, onClose }: { doc: DocumentRecord; onEdit: () => void; anchorRef: HTMLElement | null; anchor: DOMRect; onClose: () => void }) {
  return (
    <Menu
      anchor={anchor}
      onClose={onClose}
      ignore={[anchorRef]}
      items={[
        { label: doc.lastOpenedAt ? 'Continue reading' : 'Start reading', icon: <BookOpen size={14} />, onSelect: () => openDoc(doc) },
        { label: doc.favorite ? 'Remove from favorites' : 'Add to favorites', icon: <Heart size={14} />, onSelect: () => void updateDocument(doc.id, { favorite: !doc.favorite }) },
        { label: 'Details & collections…', icon: <Pencil size={14} />, onSelect: onEdit },
        'sep',
        { label: 'Remove from library', icon: <Trash2 size={14} />, danger: true, onSelect: () => removeDoc(doc) },
      ]}
    />
  );
}

function ProgressLine({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx('h-[3px] overflow-hidden rounded-full bg-ink/10', className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label="Reading progress">
      <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${value}%` }} />
    </div>
  );
}

function BookCard({ doc, onEdit, index }: { doc: DocumentRecord; onEdit: (d: DocumentRecord) => void; index: number }) {
  const menu = usePopover();
  const pct = progressOf(doc);
  const status = doc.completedAt ? 'Finished' : doc.lastOpenedAt ? `${pct}%` : 'New';
  return (
    <article className="book group relative anim-rise" style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }} data-testid="book-card">
      <button onClick={() => openDoc(doc)} className="block w-full text-left focus:outline-none" aria-label={`Open ${doc.title}`}>
        <BookCover doc={doc} />
      </button>
      <button
        onClick={() => void updateDocument(doc.id, { favorite: !doc.favorite })}
        aria-label={doc.favorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-pressed={doc.favorite}
        data-tip={doc.favorite ? 'Favorite' : 'Add to favorites'}
        className={cx(
          'absolute top-2 right-2 grid h-8 w-8 place-items-center rounded-full bg-surface/90 shadow-soft backdrop-blur transition-all',
          doc.favorite ? 'text-accent opacity-100' : 'text-ink-2 opacity-0 group-hover:opacity-100 focus:opacity-100',
        )}
      >
        <Heart size={15} fill={doc.favorite ? 'currentColor' : 'none'} />
      </button>
      <div className="mt-3.5 flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 font-serif text-[14.5px] leading-snug font-medium text-ink" title={doc.title}>
            {doc.title}
          </h3>
          <p className="mt-0.5 truncate text-[12.5px] text-ink-3">{doc.author || doc.fileName}</p>
        </div>
        <button ref={menu.triggerRef} onClick={menu.toggle} aria-label={`More options for ${doc.title}`} className="icon-btn -mr-2 h-7 w-7 shrink-0 opacity-60 group-hover:opacity-100">
          <MoreHorizontal size={16} />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2.5">
        <ProgressLine value={doc.lastOpenedAt ? pct : 0} className="flex-1" />
        <span className={cx('text-[11.5px] tabular-nums', doc.completedAt ? 'text-accent' : 'text-ink-3')}>{status}</span>
      </div>
      <p className="mt-1 text-[11.5px] text-ink-3">
        {doc.index.status === 'indexing' || doc.index.status === 'pending'
          ? `Indexing text · ${Math.round((doc.index.pagesIndexed / doc.pageCount) * 100)}%`
          : doc.lastOpenedAt
            ? `Read ${relativeTime(doc.lastOpenedAt).toLowerCase()}`
            : `Added ${relativeTime(doc.addedAt).toLowerCase()}`}
      </p>
      {menu.anchor && <BookMenu doc={doc} anchor={menu.anchor} anchorRef={menu.triggerRef.current} onClose={menu.close} onEdit={() => onEdit(doc)} />}
    </article>
  );
}

function ContinueCard({ doc, index }: { doc: DocumentRecord; index: number }) {
  const pct = progressOf(doc);
  const section = useMemo(() => {
    // Find the outline entry for the current page (cheap: flatten on render, outlines are small).
    let best: string | null = null;
    let bestPage = 0;
    const walk = (nodes: DocumentRecord['outline']) =>
      nodes.forEach((n) => {
        if (n.page && n.page <= doc.currentPage && n.page >= bestPage) {
          best = n.title;
          bestPage = n.page;
        }
        walk(n.children);
      });
    walk(doc.outline);
    return best as string | null;
  }, [doc]);
  return (
    <button onClick={() => openDoc(doc)} className="book group flex w-[300px] shrink-0 items-stretch gap-4 rounded-2xl p-2 pr-4 text-left transition-colors hover:bg-ink/[0.035] anim-rise sm:w-[340px]" style={{ animationDelay: `${index * 50}ms` }}>
      <BookCover doc={doc} className="w-[78px] shrink-0 self-start" eager />
      <div className="flex min-w-0 flex-1 flex-col py-1">
        <span className="eyebrow mb-1 text-[10px]">{relativeTime(doc.lastOpenedAt)}</span>
        <h3 className="line-clamp-2 font-serif text-[15.5px] leading-snug font-medium">{doc.title}</h3>
        {section && <p className="mt-1 truncate text-[12.5px] text-ink-3 italic">{section}</p>}
        <div className="mt-auto pt-3">
          <div className="mb-1.5 flex justify-between text-[11.5px] text-ink-3 tabular-nums">
            <span>
              {doc.format === 'epub' ? `Section ${doc.currentPage} of ${doc.pageCount}` : `Page ${doc.currentPage} of ${doc.pageCount}`}
            </span>
            <span>{pct}%</span>
          </div>
          <ProgressLine value={pct} />
        </div>
      </div>
    </button>
  );
}

function UploadTiles({ collection }: { collection?: string }) {
  const items = useUploads((s) => s.items);
  const dismiss = useUploads((s) => s.dismiss);
  const addLink = useUploads((s) => s.addLink);
  if (!items.length) return null;
  return (
    <div className="mb-8 grid gap-2.5" aria-live="polite">
      {items.map((u) => (
        <div key={u.id} className={cx('flex items-center gap-3.5 rounded-xl px-4 py-3 anim-rise', u.stage === 'error' ? 'bg-danger/[0.07]' : 'bg-ink/[0.04]')} data-testid="upload-status">
          {u.stage === 'error' ? <AlertCircle size={18} className="shrink-0 text-danger" /> : <Spinner size={16} className="shrink-0 text-accent" />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{u.name}</div>
            <div className={cx('text-[12.5px]', u.stage === 'error' ? 'text-danger' : 'text-ink-3')}>
              {u.stage === 'error' ? u.error : stageLabel(u.stage)}
              {u.stage !== 'error' && u.detail && <span className="tabular-nums"> · {u.detail}</span>}
            </div>
            {u.stage !== 'error' && <ProgressLine value={Math.round(u.fraction * 100)} className="mt-2" />}
          </div>
          {u.stage === 'error' && u.link && (
            <button className="icon-btn" aria-label="Try again" data-tip="Try again" onClick={() => void addLink(u.link!, { collectionId: collection })}>
              <RotateCw size={15} />
            </button>
          )}
          {(u.stage === 'error' || u.stage === 'downloading') && (
            <button className="icon-btn" aria-label={u.stage === 'error' ? 'Dismiss' : 'Cancel download'} onClick={() => dismiss(u.id)}>
              <X size={15} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function EditDialog({ doc, collections, onClose }: { doc: DocumentRecord; collections: Collection[]; onClose: () => void }) {
  const [title, setTitle] = useState(doc.title);
  const [author, setAuthor] = useState(doc.author);
  const [ids, setIds] = useState<string[]>(doc.collectionIds);
  const save = async () => {
    await updateDocument(doc.id, { title: title.trim() || doc.title, author: author.trim(), collectionIds: ids });
    onClose();
  };
  return (
    <Dialog
      title="Details & collections"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="grid gap-1.5 text-[12.5px] text-ink-2">
          Title
          <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="grid gap-1.5 text-[12.5px] text-ink-2">
          Author
          <input className="field" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Unknown" />
        </label>
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-[12.5px] text-ink-2">Collections</legend>
          {collections.length ? (
            <div className="flex flex-wrap gap-1.5">
              {collections.map((c) => {
                const on = ids.includes(c.id);
                return (
                  <button
                    type="button"
                    key={c.id}
                    aria-pressed={on}
                    onClick={() => setIds(on ? ids.filter((x) => x !== c.id) : [...ids, c.id])}
                    className={cx('rounded-full px-3 py-1 text-[12.5px] transition-colors', on ? 'bg-accent text-accent-ink' : 'bg-ink/[0.06] text-ink-2 hover:bg-ink/10')}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-[12.5px] text-ink-3">No collections yet — create one from the sidebar.</p>
          )}
        </fieldset>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-line pt-3 text-[12px] text-ink-3">
          <dt>File</dt>
          <dd className="truncate">{doc.fileName}</dd>
          <dt>Size</dt>
          <dd>
            {doc.format.toUpperCase()} · {formatBytes(doc.fileSize)} · {doc.pageCount} {doc.format === 'epub' ? 'sections' : 'pages'}
          </dd>
          {doc.sourceUrl && (
            <>
              <dt>Source</dt>
              <dd className="truncate">
                <a href={doc.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline" data-testid="doc-source">
                  {doc.sourceUrl.replace(/^https?:\/\//, '')}
                </a>
              </dd>
            </>
          )}
          {doc.producer && (
            <>
              <dt>Producer</dt>
              <dd className="truncate">{doc.producer}</dd>
            </>
          )}
        </dl>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function Shelf({ title, count, children, action }: { title: string; count?: number; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="mb-12">
      <div className="mb-5 flex items-baseline gap-3 border-b border-line pb-2.5">
        <h2 className="font-display text-[19px] font-medium tracking-tight">{title}</h2>
        {count !== undefined && <span className="text-[12.5px] text-ink-3 tabular-nums">{count}</span>}
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */

export function LibraryPage({ collection }: { collection?: string }) {
  const docs = useLive(listDocuments, ['documents'], []);
  const collections = useLive(listCollections, ['collections'], []) ?? [];
  const days = useLive(listDays, ['days'], []) ?? [];
  const sort = usePrefs((s) => s.librarySort);
  const setPrefs = usePrefs((s) => s.set);
  const addUploads = useUploads((s) => s.add);
  const addLink = useUploads((s) => s.addLink);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<DocumentRecord | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const sortMenu = usePopover();
  const searchRef = useRef<HTMLInputElement>(null);

  const activeCollection = collection === 'favorites' ? null : collections.find((c) => c.id === collection);
  const scopeTitle = collection === 'favorites' ? 'Favorites' : activeCollection?.name;

  // Drag & drop anywhere on the page.
  useEffect(() => {
    let depth = 0;
    // Files, or a link dragged in from another tab (Folio's own links are ignored on drop).
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files') || !!e.dataTransfer?.types.includes('text/uri-list');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) return void addUploads(files, { collectionId: collection });
      const link = e.dataTransfer?.getData('text/uri-list').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
      const href = link ? normalizeLink(link) : null;
      if (link && href && new URL(href).origin !== location.origin) void addLink(link, { collectionId: collection });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [addUploads, addLink, collection]);

  // Pasting a link onto the library page offers to add it.
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement).closest?.('input, textarea, [contenteditable="true"], [role="dialog"]')) return;
      const text = e.clipboardData?.getData('text/plain')?.trim() ?? '';
      if (!text || !normalizeLink(text) || !/^(https?:\/\/|doi:|arxiv:|10\.\d|\d{4}\.\d)/i.test(text)) return;
      e.preventDefault();
      setLinkDraft(text);
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, []);

  // "/" focuses library search.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target as HTMLElement).closest('input, textarea')) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const scoped = useMemo(() => {
    if (!docs) return [];
    if (collection === 'favorites') return docs.filter((d) => d.favorite);
    if (collection) return docs.filter((d) => d.collectionIds.includes(collection));
    return docs;
  }, [docs, collection]);
  const results = useMemo(() => sortDocs(query ? scoped.filter((d) => matches(d, query)) : scoped, sort), [scoped, query, sort]);
  const continueReading = useMemo(() => (docs ?? []).filter((d) => d.lastOpenedAt && !d.completedAt).sort((a, b) => b.lastOpenedAt! - a.lastOpenedAt!).slice(0, 6), [docs]);
  const recentlyAdded = useMemo(() => [...(docs ?? [])].sort((a, b) => b.addedAt - a.addedAt).slice(0, 6), [docs]);

  const today = days.find((d) => d.date === dayKey());
  const pagesToday = today ? Object.values(today.pages).reduce((n, p) => n + p.length, 0) : 0;
  const inProgress = (docs ?? []).filter((d) => d.lastOpenedAt && !d.completedAt).length;

  const pick = () => fileRef.current?.click();
  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept={ACCEPT_ATTR}
      multiple
      hidden
      data-testid="file-input"
      onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (files.length) void addUploads(files, { collectionId: collection });
      }}
    />
  );

  const showHome = !query && !collection;
  const grid = (list: DocumentRecord[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-6 gap-y-10 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] sm:gap-x-8">
      {list.map((d, i) => (
        <BookCard key={d.id} doc={d} onEdit={setEditing} index={i} />
      ))}
    </div>
  );

  return (
    <div className="mx-auto max-w-[1180px] px-5 pt-8 pb-16 sm:px-10 md:pt-12">
      {fileInput}

      {/* Masthead */}
      <header className="mb-10 flex flex-wrap items-end gap-x-8 gap-y-5">
        <div className="min-w-0 flex-1">
          <p className="eyebrow mb-2">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          <h1 className="font-display text-[30px] leading-tight font-medium tracking-tight sm:text-[36px]">{scopeTitle ?? `${greeting()}.`}</h1>
          {!scopeTitle && docs && docs.length > 0 && (
            <p className="mt-1.5 font-serif text-[15px] text-ink-2 italic">
              {inProgress ? `${inProgress} ${inProgress === 1 ? 'book' : 'books'} in progress` : 'Nothing open at the moment'}
              {pagesToday ? ` · ${pagesToday} ${pagesToday === 1 ? 'page' : 'pages'} read today` : ''}.
            </p>
          )}
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <label className="relative flex-1 sm:w-[260px] sm:flex-none">
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" />
            <input
              ref={searchRef}
              className="field h-9 rounded-full pr-8 pl-9 text-[13px]"
              placeholder="Search title, author, file…"
              aria-label="Search library"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            />
            {query && (
              <button className="absolute top-1/2 right-2 -translate-y-1/2 text-ink-3 hover:text-ink" aria-label="Clear search" onClick={() => setQuery('')}>
                <X size={14} />
              </button>
            )}
          </label>
          <button ref={sortMenu.triggerRef} className="icon-btn" aria-label="Sort" data-tip={`Sort: ${SORTS.find((s) => s.value === sort)?.label}`} onClick={sortMenu.toggle}>
            <ArrowDownWideNarrow size={17} />
          </button>
          {sortMenu.anchor && (
            <Menu
              anchor={sortMenu.anchor}
              onClose={sortMenu.close}
              ignore={[sortMenu.triggerRef.current]}
              title="Sort by"
              items={SORTS.map((s) => ({ label: s.label, checked: sort === s.value, onSelect: () => setPrefs({ librarySort: s.value }) }))}
            />
          )}
          <button className="icon-btn" aria-label="Add from link" data-tip="Add from a link" data-testid="add-link" onClick={() => setLinkDraft('')}>
            <Link2 size={17} />
          </button>
          <button className="btn btn-primary" onClick={pick}>
            <UploadIcon size={15} /> <span className="hidden sm:inline">Add books</span>
          </button>
        </div>
      </header>

      <UploadTiles collection={collection} />

      {docs === undefined ? (
        <div className="grid h-60 place-items-center text-ink-3">
          <Spinner size={20} />
        </div>
      ) : docs.length === 0 ? (
        <EmptyLibrary onPick={pick} onLink={() => setLinkDraft('')} />
      ) : showHome ? (
        <>
          {continueReading.length > 0 && (
            <Shelf title="Continue reading">
              <div className="-mx-2 flex gap-3 overflow-x-auto pb-2">
                {continueReading.map((d, i) => (
                  <ContinueCard key={d.id} doc={d} index={i} />
                ))}
              </div>
            </Shelf>
          )}
          {docs.length > 6 && (
            <Shelf title="Recently added">
              <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-6 gap-y-10 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] sm:gap-x-8">
                {recentlyAdded.map((d, i) => (
                  <BookCard key={d.id} doc={d} onEdit={setEditing} index={i} />
                ))}
              </div>
            </Shelf>
          )}
          <Shelf title={docs.length > 6 ? 'All books' : 'Your shelf'} count={results.length}>
            {grid(results)}
          </Shelf>
        </>
      ) : (
        <Shelf title={query ? `Results for “${query}”` : 'Books'} count={results.length}>
          {results.length ? (
            grid(results)
          ) : query ? (
            <EmptyState icon={<Search size={22} />} title="Nothing matches">
              No title, author, or file name contains “{query}”.
            </EmptyState>
          ) : (
            <EmptyState icon={collection === 'favorites' ? <Heart size={22} /> : <FolderPlus size={22} />} title={collection === 'favorites' ? 'No favorites yet' : 'This collection is empty'}>
              {collection === 'favorites' ? 'Tap the heart on any book to keep it close.' : 'Add books from their “Details & collections” menu, or drop PDFs here to add them straight into this collection.'}
            </EmptyState>
          )}
        </Shelf>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center p-6 anim-fade" style={{ background: 'color-mix(in srgb, var(--bg) 82%, transparent)', backdropFilter: 'blur(3px)' }}>
          <div className="grid place-items-center gap-3 rounded-[28px] border-2 border-dashed border-accent/50 px-16 py-14 text-center anim-pop">
            <FileUp size={34} className="text-accent" strokeWidth={1.5} />
            <div className="font-display text-[24px] font-medium">Drop to add to your library</div>
            <div className="text-[13px] text-ink-3">{scopeTitle ? `They'll be placed in “${scopeTitle}”.` : 'PDF and EPUB · stored privately in this browser'}</div>
          </div>
        </div>
      )}

      {editing && <EditDialog doc={editing} collections={collections} onClose={() => setEditing(null)} />}
      {linkDraft !== null && (
        <LinkDialog
          initial={linkDraft}
          into={scopeTitle}
          onClose={() => setLinkDraft(null)}
          onAdd={(link) => {
            setLinkDraft(null);
            void addLink(link, { collectionId: collection });
          }}
        />
      )}
    </div>
  );
}

function LinkDialog({ initial, into, onClose, onAdd }: { initial: string; into?: string; onClose: () => void; onAdd: (link: string) => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const submit = () => {
    if (!value.trim()) return setError('Paste a link first.');
    if (!normalizeLink(value)) return setError('That doesn’t look like a web link, DOI or arXiv id.');
    onAdd(value.trim());
  };
  return (
    <Dialog
      title="Add from a link"
      onClose={onClose}
      width={500}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} data-testid="link-submit">
            Add to library
          </button>
        </>
      }
    >
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="grid gap-1.5 text-[12.5px] text-ink-2">
          Link to a PDF, EPUB or paper
          <input
            className="field"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://arxiv.org/abs/1706.03762"
            value={value}
            data-testid="link-input"
            aria-invalid={!!error}
            onChange={(e) => {
              setValue(e.target.value);
              setError('');
            }}
          />
        </label>
        {error ? (
          <p className="text-[12.5px] text-danger" role="alert">
            {error}
          </p>
        ) : (
          <p className="text-[12.5px] leading-relaxed text-ink-3">
            A direct file link, or a paper’s page on arXiv, OpenReview, ACL Anthology or a journal site — Folio finds the PDF. DOIs (10.xxxx/…) and arXiv ids work too.
            {into ? ` It will be placed in “${into}”.` : ''}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function EmptyLibrary({ onPick, onLink }: { onPick: () => void; onLink: () => void }) {
  return (
    <div className="mx-auto mt-4 grid max-w-[720px] items-center gap-10 rounded-[28px] border border-dashed border-line-2 px-8 py-14 sm:grid-cols-[180px_1fr] sm:px-12 anim-rise">
      {/* A small still-life: a stack of pages */}
      <div className="relative mx-auto h-[190px] w-[150px]" aria-hidden>
        <div className="absolute inset-0 translate-x-4 translate-y-3 rotate-[5deg] rounded-[4px] bg-surface shadow-soft" />
        <div className="absolute inset-0 translate-x-1 rotate-[-3deg] rounded-[4px] bg-surface shadow-soft" />
        <div className="absolute inset-0 rounded-[4px] bg-surface p-5 shadow-pop">
          <div className="mb-3 h-2.5 w-3/4 rounded bg-ink/15" />
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="mb-2 h-1.5 rounded bg-ink/[0.07]" style={{ width: `${[100, 92, 97, 85, 100, 90, 70, 94][i]}%` }} />
          ))}
          <div className="absolute right-5 bottom-4 left-5 h-6 rounded bg-[var(--hl-yellow)]/50" style={{ top: 92, height: 8 }} />
        </div>
      </div>
      <div>
        <p className="eyebrow mb-2">An empty shelf</p>
        <h2 className="font-display text-[28px] leading-tight font-medium tracking-tight">Bring something worth reading.</h2>
        <p className="mt-3 max-w-[40ch] text-[14px] leading-relaxed text-ink-2">
          Drop PDFs or EPUBs anywhere on this page, or choose them from your computer. Everything stays private in this browser — your books, highlights and notes never leave your device.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button className="btn btn-accent" onClick={onPick}>
            <UploadIcon size={15} /> Choose books
          </button>
          <button className="btn btn-ghost" onClick={onLink}>
            <Link2 size={15} /> Add from a link
          </button>
          <span className="text-[12.5px] text-ink-3">or drag & drop</span>
        </div>
      </div>
    </div>
  );
}
