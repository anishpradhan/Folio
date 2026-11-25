import { useState, type ReactNode } from 'react';
import { Sparkles, Languages, NotebookPen, ChartNoAxesColumn, Plus, Heart, Library, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { navigate, type Route } from '../../lib/router';
import { usePrefs, type AppTheme } from '../../state/prefs';
import { useLive } from '../../data/useLive';
import { addCollection, deleteCollection, listCollections, renameCollection } from '../../data/repo';
import { cx } from '../../lib/util';
import { Menu, usePopover } from '../../components/ui';

const NAV = [
  { name: 'library', label: 'Library', icon: Library, path: '/' },
  { name: 'insights', label: 'My Insights', icon: Sparkles, path: '/insights' },
  { name: 'vocabulary', label: 'Vocabulary', icon: Languages, path: '/vocabulary' },
  { name: 'journal', label: 'Journal', icon: NotebookPen, path: '/journal' },
  { name: 'stats', label: 'Reading Life', icon: ChartNoAxesColumn, path: '/stats' },
] as const;

export const THEMES: { id: AppTheme; label: string; swatch: [string, string] }[] = [
  { id: 'editorial', label: 'Warm Editorial', swatch: ['#f5efe5', '#8b5a3c'] },
  { id: 'midnight', label: 'Midnight Library', swatch: ['#1d1c1f', '#cfa65a'] },
  { id: 'nordic', label: 'Nordic Minimal', swatch: ['#f6f6f4', '#46627e'] },
  { id: 'vintage', label: 'Vintage Paper', swatch: ['#e2d3b5', '#8e4b2e'] },
];

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx('font-display text-[25px] leading-none font-medium tracking-tight italic', className)}>
      Folio<span className="text-accent not-italic">.</span>
    </span>
  );
}

export function ThemePicker({ compact }: { compact?: boolean }) {
  const theme = usePrefs((s) => s.appTheme);
  const set = usePrefs((s) => s.set);
  return (
    <div role="radiogroup" aria-label="App theme" className={cx('flex items-center', compact ? 'gap-1.5' : 'gap-2')}>
      {THEMES.map((t) => (
        <button
          key={t.id}
          role="radio"
          aria-checked={theme === t.id}
          aria-label={t.label}
          data-tip={t.label}
          onClick={() => set({ appTheme: t.id })}
          className={cx('relative h-6 w-6 rounded-full transition-transform hover:scale-110', theme === t.id && 'ring-2 ring-accent ring-offset-2 ring-offset-bg')}
          style={{ background: `linear-gradient(135deg, ${t.swatch[0]} 50%, ${t.swatch[1]} 50%)`, boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.12)' }}
        />
      ))}
    </div>
  );
}

function CollectionRow({ id, name, active }: { id: string; name: string; active: boolean }) {
  const menu = usePopover();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  if (editing)
    return (
      <form
        className="px-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void renameCollection(id, value);
          setEditing(false);
        }}
      >
        <input autoFocus className="field h-8 py-1 text-[13px]" value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => setEditing(false)} aria-label="Collection name" />
      </form>
    );
  return (
    <div className="group relative">
      <button
        onClick={() => navigate(`/collection/${encodeURIComponent(id)}`)}
        className={cx('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] transition-colors', active ? 'bg-ink/[0.06] text-ink' : 'text-ink-2 hover:bg-ink/[0.04] hover:text-ink')}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-accent/70" />
        <span className="truncate">{name}</span>
      </button>
      <button
        ref={menu.triggerRef}
        aria-label={`Options for ${name}`}
        onClick={menu.toggle}
        className="absolute top-1/2 right-1 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-ink/5 focus:opacity-100"
      >
        <MoreHorizontal size={14} />
      </button>
      {menu.anchor && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          ignore={[menu.triggerRef.current]}
          align="start"
          items={[
            { label: 'Rename', icon: <Pencil size={14} />, onSelect: () => setEditing(true) },
            {
              label: 'Delete collection',
              icon: <Trash2 size={14} />,
              danger: true,
              onSelect: () => {
                void deleteCollection(id);
                if (active) navigate('/');
              },
            },
          ]}
        />
      )}
    </div>
  );
}

export function AppShell({ route, children }: { route: Route; children: ReactNode }) {
  const collections = useLive(listCollections, ['collections'], []) ?? [];
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const activeCollection = route.name === 'library' ? route.collection : undefined;

  return (
    <div className="flex min-h-full">
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col border-r border-line px-4 pt-7 pb-5 md:flex">
        <button onClick={() => navigate('/')} className="mb-8 self-start px-2.5 text-left" aria-label="Folio — Library">
          <Wordmark />
        </button>
        <nav aria-label="Primary" className="grid gap-0.5">
          {NAV.map((n) => {
            const active = route.name === n.name && !(n.name === 'library' && activeCollection);
            return (
              <button
                key={n.name}
                onClick={() => navigate(n.path)}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors',
                  active ? 'bg-ink/[0.06] font-medium text-ink' : 'text-ink-2 hover:bg-ink/[0.04] hover:text-ink',
                )}
              >
                <n.icon size={16} strokeWidth={1.75} className={active ? 'text-accent' : 'text-ink-3'} />
                {n.label}
              </button>
            );
          })}
        </nav>

        <div className="mt-8 mb-2 flex items-center justify-between px-2.5">
          <span className="eyebrow">Collections</span>
          <button aria-label="New collection" data-tip="New collection" onClick={() => setAdding(true)} className="grid h-6 w-6 place-items-center rounded-md text-ink-3 hover:bg-ink/5 hover:text-ink">
            <Plus size={14} />
          </button>
        </div>
        <div className="-mx-1 grid min-h-0 flex-1 content-start gap-0.5 overflow-y-auto px-1">
          <button
            onClick={() => navigate('/collection/favorites')}
            className={cx(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] transition-colors',
              activeCollection === 'favorites' ? 'bg-ink/[0.06] text-ink' : 'text-ink-2 hover:bg-ink/[0.04] hover:text-ink',
            )}
          >
            <Heart size={13} className="text-accent" />
            Favorites
          </button>
          {collections.map((c) => (
            <CollectionRow key={c.id} id={c.id} name={c.name} active={activeCollection === c.id} />
          ))}
          {adding && (
            <form
              className="px-1 pt-1"
              onSubmit={async (e) => {
                e.preventDefault();
                if (name.trim()) {
                  const c = await addCollection(name);
                  navigate(`/collection/${c.id}`);
                }
                setName('');
                setAdding(false);
              }}
            >
              <input
                autoFocus
                className="field h-8 py-1 text-[13px]"
                placeholder="Collection name"
                aria-label="New collection name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => !name.trim() && setAdding(false)}
                onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
              />
            </form>
          )}
          {!collections.length && !adding && (
            <button onClick={() => setAdding(true)} className="px-2.5 py-1.5 text-left text-[12.5px] text-ink-3 italic hover:text-ink-2">
              Group books into shelves of your own…
            </button>
          )}
        </div>

        <div className="mt-4 border-t border-line px-2.5 pt-4">
          <div className="eyebrow mb-2.5">Theme</div>
          <ThemePicker />
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-bg/90 px-4 py-3 backdrop-blur md:hidden">
          <button onClick={() => navigate('/')} aria-label="Library">
            <Wordmark className="text-[22px]" />
          </button>
          <ThemePicker compact />
        </header>
        <main className="min-w-0 flex-1 pb-20 md:pb-0">{children}</main>
        <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-line bg-bg/95 px-2 pt-1.5 pb-[max(6px,env(safe-area-inset-bottom))] backdrop-blur md:hidden">
          {NAV.map((n) => (
            <button key={n.name} onClick={() => navigate(n.path)} className={cx('flex flex-col items-center gap-0.5 px-2 py-1 text-[10.5px]', route.name === n.name ? 'text-accent' : 'text-ink-3')}>
              <n.icon size={18} strokeWidth={1.75} />
              {n.label.replace('My ', '').replace('Reading ', '')}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
