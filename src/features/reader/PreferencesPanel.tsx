import { useEffect, useState } from 'react';
import { X, RotateCcw, AlignLeft, AlignJustify, Keyboard } from 'lucide-react';
import { useReader } from './store';
import {
  usePrefs,
  PRESETS,
  SHORTCUT_ACTIONS,
  DEFAULT_SHORTCUTS,
  DEFAULT_TYPOGRAPHY,
  comboFromEvent,
  prettyCombo,
  type PagePreset,
  type Texture,
  type ShortcutAction,
  type ReadingFont,
} from '../../state/prefs';
import { IconButton, Segmented, Slider, Toggle } from '../../components/ui';
import { ThemePicker } from '../shell/AppShell';
import { FONT_STACKS } from './ReflowView';
import { cx } from '../../lib/util';

const PRESET_SWATCH: Record<PagePreset, { page: string; ink: string; bg: string }> = {
  original: { page: '#ffffff', ink: '#222', bg: 'var(--reader-bg)' },
  paper: { page: '#fbf9f4', ink: '#2a2a2a', bg: 'var(--reader-bg)' },
  warm: { page: '#f8eedc', ink: '#3a2f25', bg: '#eadfcd' },
  sepia: { page: '#ecdcbc', ink: '#4a3520', bg: '#e2d3b6' },
  dark: { page: '#262523', ink: '#e4e0d8', bg: '#1b1a18' },
  midnight: { page: '#171a22', ink: '#d6d1c4', bg: '#0f1117' },
};

const TEXTURES: { id: Texture; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'clean', label: 'Clean white' },
  { id: 'cream', label: 'Natural cream' },
  { id: 'aged', label: 'Aged' },
  { id: 'soft', label: 'Soft grain' },
];

const SURROUNDS = ['auto', '#e9e1d4', '#dcd6cc', '#e4e7ea', '#c9c2b6', '#3a3733', '#1b1a18', '#0f1117'];

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <section className="border-b border-line px-6 py-5 last:border-b-0">
      <h3 className="eyebrow mb-3.5">{title}</h3>
      {note && <div className="-mt-2 mb-3.5 text-[12px] leading-relaxed text-ink-3">{note}</div>}
      <div className="grid gap-4">{children}</div>
    </section>
  );
}

function ShortcutRow({ action }: { action: ShortcutAction }) {
  const combo = usePrefs((s) => s.shortcuts[action]);
  const setShortcut = usePrefs((s) => s.setShortcut);
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    if (!recording) return;
    const on = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setRecording(false);
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setShortcut(action, '');
        return setRecording(false);
      }
      const c = comboFromEvent(e);
      if (!c) return;
      setShortcut(action, c);
      setRecording(false);
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [recording, action, setShortcut]);
  return (
    <div className="flex items-center justify-between gap-3 text-[12.5px]">
      <span className="text-ink-2">{SHORTCUT_ACTIONS[action]}</span>
      <button
        onClick={() => setRecording(!recording)}
        className={cx('min-w-[64px] rounded-md px-2 py-1 text-center text-[11.5px] font-semibold transition-colors', recording ? 'bg-accent text-accent-ink' : 'kbd hover:bg-ink/10')}
        aria-label={`Change shortcut for ${SHORTCUT_ACTIONS[action]}`}
        data-tip={recording ? 'Press keys · Esc to cancel · Delete to clear' : 'Click to change'}
      >
        {recording ? 'Press keys…' : prettyCombo(combo)}
      </button>
    </div>
  );
}

export function PreferencesPanel() {
  const open = useReader((s) => s.prefsOpen);
  const view = useReader((s) => s.view);
  const epub = useReader((s) => s.doc?.format === 'epub');
  const set = useReader((s) => s.set);
  const p = usePrefs();
  const a = p.appearance;
  const t = p.typography;
  const [tab, setTab] = useState<'page' | 'text' | 'reading'>('page');

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-label="Reading preferences" data-testid="preferences">
      <button className="absolute inset-0 cursor-default" aria-label="Close preferences" onClick={() => set({ prefsOpen: false })} />
      <aside className="absolute top-2 right-2 bottom-2 flex w-[min(380px,calc(100vw-16px))] flex-col overflow-hidden rounded-2xl bg-surface shadow-pop anim-rise">
        <header className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="font-display text-[20px] font-medium tracking-tight">Reading room</h2>
          <IconButton label="Close" onClick={() => set({ prefsOpen: false })}>
            <X size={16} />
          </IconButton>
        </header>
        <div role="tablist" className="flex gap-5 border-b border-line px-6">
          {(
            [
              ['page', 'Page'],
              ['text', 'Typography'],
              ['reading', 'Reading'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className="tab pb-2.5" onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'page' && (
            <>
              <Section title="Presets">
                <div className="grid grid-cols-3 gap-2.5">
                  {(Object.keys(PRESETS) as PagePreset[]).map((id) => {
                    const sw = PRESET_SWATCH[id];
                    const on = a.preset === id;
                    return (
                      <button key={id} onClick={() => p.applyPreset(id)} aria-pressed={on} data-testid={`preset-${id}`} className={cx('group rounded-xl p-1.5 text-center transition-all', on ? 'ring-2 ring-accent' : 'ring-1 ring-line hover:ring-line-2')}>
                        <div className="grid h-14 place-items-center rounded-lg" style={{ background: sw.bg }}>
                          <div className="flex h-10 w-8 flex-col gap-[3px] rounded-[2px] p-1.5 shadow-sm" style={{ background: sw.page }}>
                            {[100, 80, 92, 60].map((w, i) => (
                              <span key={i} className="h-[2px] rounded" style={{ width: `${w}%`, background: sw.ink, opacity: 0.55 }} />
                            ))}
                          </div>
                        </div>
                        <span className={cx('mt-1.5 block text-[11.5px]', on ? 'font-semibold text-ink' : 'text-ink-2')}>{PRESETS[id].label}</span>
                      </button>
                    );
                  })}
                </div>
                {a.preset === 'custom' && <p className="text-[11.5px] text-ink-3 italic">Custom — adjusted from a preset.</p>}
              </Section>

              <Section title="Paper">
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Paper texture">
                  {TEXTURES.map((tx) => (
                    <button
                      key={tx.id}
                      role="radio"
                      aria-checked={a.texture === tx.id}
                      onClick={() => p.setAppearance({ texture: tx.id })}
                      className={cx('rounded-full px-3 py-1 text-[12px] transition-colors', a.texture === tx.id ? 'bg-ink text-bg' : 'bg-ink/[0.05] text-ink-2 hover:bg-ink/10')}
                    >
                      {tx.label}
                    </button>
                  ))}
                </div>
                <Slider label="Paper warmth" value={a.warmth} min={0} max={100} onChange={(v) => p.setAppearance({ warmth: v })} format={(v) => `${v}`} />
                <Slider label="Sepia" value={a.sepia} min={0} max={100} onChange={(v) => p.setAppearance({ sepia: v })} format={(v) => `${v}%`} />
                <Slider label="Brightness" value={a.brightness} min={50} max={120} onChange={(v) => p.setAppearance({ brightness: v })} format={(v) => `${v}%`} />
                <Slider label="Contrast" value={a.contrast} min={70} max={140} onChange={(v) => p.setAppearance({ contrast: v })} format={(v) => `${v}%`} />
                <Toggle label="Dark pages (invert)" checked={a.invert} onChange={(v) => p.setAppearance({ invert: v })} />
              </Section>

              <Section title="Surroundings">
                <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Background colour">
                  {SURROUNDS.map((c) => (
                    <button
                      key={c}
                      role="radio"
                      aria-checked={a.surround === c}
                      aria-label={c === 'auto' ? 'Match theme' : c}
                      data-tip={c === 'auto' ? 'Match theme' : c}
                      onClick={() => p.setAppearance({ surround: c })}
                      className={cx('h-7 w-7 rounded-full ring-offset-2 ring-offset-surface transition-transform hover:scale-110', a.surround === c ? 'ring-2 ring-accent' : 'ring-1 ring-line-2')}
                      style={{ background: c === 'auto' ? 'linear-gradient(135deg, var(--reader-bg) 50%, var(--bg-2) 50%)' : c }}
                    />
                  ))}
                  <label className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full ring-1 ring-line-2" data-tip="Custom colour" style={{ background: 'conic-gradient(#e66, #ec6, #6c6, #6ce, #66e, #e6e, #e66)' }}>
                    <input type="color" className="absolute inset-0 cursor-pointer opacity-0" aria-label="Custom background colour" value={a.surround.startsWith('#') ? a.surround : '#e9e1d4'} onChange={(e) => p.setAppearance({ surround: e.target.value })} />
                  </label>
                </div>
                <Slider label="Page shadow" value={a.shadow} min={0} max={100} onChange={(v) => p.setAppearance({ shadow: v })} />
                <Slider label="Page spacing" value={a.pageGap} min={4} max={80} onChange={(v) => p.setAppearance({ pageGap: v })} format={(v) => `${v}px`} />
                <Slider label="Reading width (fit to width)" value={a.readingWidth} min={520} max={1600} step={20} onChange={(v) => p.setAppearance({ readingWidth: v })} format={(v) => `${v}px`} />
              </Section>
            </>
          )}

          {tab === 'text' && (
            <>
              <Section
                title="Typography"
                note={
                  <>
                    {epub ? (
                      <>EPUB books re-flow to fit the screen, so these settings shape the whole book. <span className="kbd">=</span> / <span className="kbd">-</span> also change the text size.</>
                    ) : (
                      <>
                        PDFs are fixed-layout, so their original typography is preserved. These settings shape the <b className="font-semibold text-ink-2">text view</b>, which re-flows the document’s text.
                      </>
                    )}
                    {!epub && view !== 'reflow' && (
                      <button className="mt-2 block font-semibold text-accent hover:underline" onClick={() => set({ view: 'reflow' })}>
                        Switch to text view →
                      </button>
                    )}
                  </>
                }
              >
                <div className="grid gap-1.5" role="radiogroup" aria-label="Font">
                  {(Object.keys(FONT_STACKS) as ReadingFont[]).map((f) => (
                    <button
                      key={f}
                      role="radio"
                      aria-checked={t.font === f}
                      onClick={() => p.setTypography({ font: f })}
                      className={cx('flex items-center justify-between rounded-lg px-3 py-2 text-left transition-colors', t.font === f ? 'bg-accent/10 text-ink' : 'text-ink-2 hover:bg-ink/[0.04]')}
                      style={{ fontFamily: FONT_STACKS[f].stack }}
                    >
                      <span className="text-[15px]">{FONT_STACKS[f].label}</span>
                      <span className="text-[13px] text-ink-3">Aa Bb 123</span>
                    </button>
                  ))}
                </div>
                <Slider label="Font size" value={t.size} min={14} max={30} onChange={(v) => p.setTypography({ size: v })} format={(v) => `${v}px`} />
                <Slider label="Line height" value={t.lineHeight} min={1.2} max={2.3} step={0.05} onChange={(v) => p.setTypography({ lineHeight: v })} format={(v) => v.toFixed(2)} />
                <Slider label="Letter spacing" value={t.letterSpacing} min={-0.03} max={0.12} step={0.005} onChange={(v) => p.setTypography({ letterSpacing: v })} format={(v) => `${v.toFixed(3)}em`} />
                <Slider label="Paragraph spacing" value={t.paragraphSpacing} min={0} max={2.4} step={0.1} onChange={(v) => p.setTypography({ paragraphSpacing: v })} format={(v) => `${v.toFixed(1)}em`} />
                <Slider label="Line length" value={t.width} min={420} max={960} step={10} onChange={(v) => p.setTypography({ width: v })} format={(v) => `${v}px`} />
                <div className="flex items-center justify-between text-[12.5px] text-ink-2">
                  Alignment
                  <Segmented
                    label="Text alignment"
                    size="sm"
                    value={t.align}
                    onChange={(v) => p.setTypography({ align: v })}
                    options={[
                      { value: 'left', label: <AlignLeft size={14} />, tip: 'Left' },
                      { value: 'justify', label: <AlignJustify size={14} />, tip: 'Justified' },
                    ]}
                  />
                </div>
                <button className="btn btn-ghost justify-self-start px-2 text-[12px]" onClick={() => p.setTypography(DEFAULT_TYPOGRAPHY)}>
                  <RotateCcw size={13} /> Reset typography
                </button>
              </Section>
            </>
          )}

          {tab === 'reading' && (
            <>
              <Section title="App theme">
                <ThemePicker />
              </Section>
              <Section title="Defaults for new books">
                <div className="flex items-center justify-between text-[12.5px] text-ink-2">
                  Layout
                  <Segmented
                    label="Default layout"
                    size="sm"
                    value={p.defaultLayout}
                    onChange={(v) => p.set({ defaultLayout: v })}
                    options={[
                      { value: 'continuous', label: 'Scroll' },
                      { value: 'single', label: 'Page' },
                      { value: 'spread', label: 'Spread' },
                    ]}
                  />
                </div>
                <div className="flex items-center justify-between text-[12.5px] text-ink-2">
                  Zoom
                  <Segmented
                    label="Default zoom"
                    size="sm"
                    value={p.defaultZoom === 'custom' ? 'fit-width' : p.defaultZoom}
                    onChange={(v) => p.set({ defaultZoom: v })}
                    options={[
                      { value: 'fit-width', label: 'Fit width' },
                      { value: 'fit-page', label: 'Fit page' },
                    ]}
                  />
                </div>
                <Toggle label="Show reading timer" checked={p.showTimer} onChange={(v) => p.set({ showTimer: v })} />
                <Toggle label="Prepare PDFs for questions automatically" checked={p.aiAutoPrepare} onChange={(v) => p.set({ aiAutoPrepare: v })} />
              </Section>
              <Section title="Keyboard shortcuts">
                <div className="grid gap-2">
                  {(Object.keys(SHORTCUT_ACTIONS) as ShortcutAction[]).map((k) => (
                    <ShortcutRow key={k} action={k} />
                  ))}
                </div>
                <button className="btn btn-ghost justify-self-start px-2 text-[12px]" disabled={JSON.stringify(p.shortcuts) === JSON.stringify(DEFAULT_SHORTCUTS)} onClick={p.resetShortcuts}>
                  <Keyboard size={13} /> Restore default shortcuts
                </button>
              </Section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
