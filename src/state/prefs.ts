import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { LayoutMode, ZoomMode } from '../core/types';

export type AppTheme = 'editorial' | 'midnight' | 'nordic' | 'vintage';
export type PagePreset = 'original' | 'paper' | 'warm' | 'sepia' | 'dark' | 'midnight';
export type Texture = 'none' | 'clean' | 'cream' | 'aged' | 'soft';
export type ReadingFont = 'literata' | 'garamond' | 'fraunces' | 'atkinson' | 'instrument';

export interface Appearance {
  preset: PagePreset | 'custom';
  /** Colour around the pages; 'auto' follows the app theme. */
  surround: string;
  texture: Texture;
  /** 0..100 — warm tint laid over the page. */
  warmth: number;
  /** 50..120 (%) */
  brightness: number;
  /** 70..140 (%) */
  contrast: number;
  /** 0..100 (%) */
  sepia: number;
  /** Invert page luminance for dark reading (hue-preserving). */
  invert: boolean;
  /** Maximum page width in px used by fit-to-width. */
  readingWidth: number;
  /** Gap between pages in px. */
  pageGap: number;
  /** 0..100 */
  shadow: number;
}

export interface Typography {
  font: ReadingFont;
  size: number;
  lineHeight: number;
  letterSpacing: number;
  paragraphSpacing: number;
  align: 'left' | 'justify';
  width: number;
}

export const SHORTCUT_ACTIONS = {
  nextPage: 'Next page',
  prevPage: 'Previous page',
  firstPage: 'First page',
  lastPage: 'Last page',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  fitWidth: 'Fit to width',
  fitPage: 'Fit to page',
  search: 'Search in document',
  toggleContents: 'Toggle contents panel',
  toggleNotebook: 'Toggle notebook panel',
  bookmark: 'Bookmark this page',
  focusMode: 'Distraction-free mode',
  fullscreen: 'Full screen',
  darkMode: 'Light / dark pages',
  cycleLayout: 'Cycle page layout',
  reflow: 'Toggle text view',
  preferences: 'Reading preferences',
} as const;
export type ShortcutAction = keyof typeof SHORTCUT_ACTIONS;

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  nextPage: 'ArrowRight',
  prevPage: 'ArrowLeft',
  firstPage: 'Home',
  lastPage: 'End',
  zoomIn: '=',
  zoomOut: '-',
  fitWidth: 'W',
  fitPage: 'P',
  search: 'Mod+F',
  toggleContents: '[',
  toggleNotebook: ']',
  bookmark: 'B',
  focusMode: 'F',
  fullscreen: 'Shift+F',
  darkMode: 'D',
  cycleLayout: 'L',
  reflow: 'T',
  preferences: ',',
};

export const PRESETS: Record<PagePreset, Omit<Appearance, 'readingWidth' | 'pageGap' | 'shadow' | 'preset'> & { label: string }> = {
  original: { label: 'Original', surround: 'auto', texture: 'none', warmth: 0, brightness: 100, contrast: 100, sepia: 0, invert: false },
  paper: { label: 'Paper', surround: 'auto', texture: 'soft', warmth: 8, brightness: 99, contrast: 98, sepia: 0, invert: false },
  warm: { label: 'Warm', surround: '#eadfcd', texture: 'cream', warmth: 32, brightness: 98, contrast: 97, sepia: 8, invert: false },
  sepia: { label: 'Sepia', surround: '#e2d3b6', texture: 'aged', warmth: 22, brightness: 96, contrast: 95, sepia: 55, invert: false },
  dark: { label: 'Dark', surround: '#1b1a18', texture: 'none', warmth: 0, brightness: 90, contrast: 92, sepia: 0, invert: true },
  midnight: { label: 'Midnight', surround: '#0f1117', texture: 'none', warmth: 6, brightness: 84, contrast: 90, sepia: 18, invert: true },
};

export const DEFAULT_APPEARANCE: Appearance = {
  preset: 'original',
  ...PRESETS.original,
  readingWidth: 880,
  pageGap: 24,
  shadow: 55,
};
delete (DEFAULT_APPEARANCE as Partial<{ label: string }>).label;

export const DEFAULT_TYPOGRAPHY: Typography = {
  font: 'literata',
  size: 19,
  lineHeight: 1.7,
  letterSpacing: 0,
  paragraphSpacing: 0.9,
  align: 'left',
  width: 680,
};

export type LeftTab = 'contents' | 'pages' | 'search';
export type RightTab = 'highlights' | 'bookmarks' | 'notes' | 'ask';
export type LibrarySort = 'opened' | 'added' | 'title' | 'progress';

interface PrefsState {
  appTheme: AppTheme;
  appearance: Appearance;
  typography: Typography;
  shortcuts: Record<ShortcutAction, string>;
  showTimer: boolean;
  defaultLayout: LayoutMode;
  defaultZoom: ZoomMode;
  leftOpen: boolean;
  rightOpen: boolean;
  leftTab: LeftTab;
  rightTab: RightTab;
  librarySort: LibrarySort;
  /** Prepare PDFs for the assistant as soon as they're added (and when one that isn't is opened). */
  aiAutoPrepare: boolean;
  /** Last light preset, restored when toggling dark pages off. */
  lastLightPreset: PagePreset;

  set: (patch: Partial<Omit<PrefsState, 'set' | 'setAppearance' | 'setTypography' | 'applyPreset' | 'toggleDark' | 'setShortcut' | 'resetShortcuts'>>) => void;
  setAppearance: (patch: Partial<Appearance>) => void;
  setTypography: (patch: Partial<Typography>) => void;
  applyPreset: (p: PagePreset) => void;
  toggleDark: () => void;
  setShortcut: (a: ShortcutAction, combo: string) => void;
  resetShortcuts: () => void;
}

const isDarkPreset = (p: Appearance['preset']) => p === 'dark' || p === 'midnight';

export const usePrefs = create<PrefsState>()(
  persist(
    (set, get) => ({
      appTheme: 'editorial',
      appearance: DEFAULT_APPEARANCE,
      typography: DEFAULT_TYPOGRAPHY,
      shortcuts: DEFAULT_SHORTCUTS,
      showTimer: false,
      defaultLayout: 'continuous',
      defaultZoom: 'fit-width',
      leftOpen: true,
      rightOpen: false,
      leftTab: 'contents',
      rightTab: 'highlights',
      librarySort: 'opened',
      aiAutoPrepare: true,
      lastLightPreset: 'original',

      set: (patch) => set(patch),
      setAppearance: (patch) =>
        set((s) => ({
          appearance: {
            ...s.appearance,
            ...patch,
            // Manual tweaks to look-related fields turn the preset into "custom".
            preset: patch.preset ?? (Object.keys(patch).some((k) => !['readingWidth', 'pageGap', 'shadow'].includes(k)) ? 'custom' : s.appearance.preset),
          },
        })),
      setTypography: (patch) => set((s) => ({ typography: { ...s.typography, ...patch } })),
      applyPreset: (p) => {
        const { label: _label, ...look } = PRESETS[p];
        void _label;
        set((s) => ({
          appearance: { ...s.appearance, ...look, preset: p },
          lastLightPreset: isDarkPreset(p) ? s.lastLightPreset : p,
        }));
      },
      toggleDark: () => {
        const { appearance, lastLightPreset, appTheme } = get();
        if (appearance.invert) get().applyPreset(lastLightPreset);
        else get().applyPreset(appTheme === 'midnight' ? 'midnight' : 'dark');
      },
      setShortcut: (a, combo) =>
        set((s) => {
          const next = { ...s.shortcuts };
          // Keep combos unique: unbind any other action that used this combo.
          (Object.keys(next) as ShortcutAction[]).forEach((k) => {
            if (k !== a && next[k] === combo) next[k] = '';
          });
          next[a] = combo;
          return { shortcuts: next };
        }),
      resetShortcuts: () => set({ shortcuts: DEFAULT_SHORTCUTS }),
    }),
    {
      name: 'folio:prefs',
      version: 1,
      storage: createJSONStorage(() => {
        try {
          localStorage.setItem('folio:probe', '1');
          localStorage.removeItem('folio:probe');
          return localStorage;
        } catch {
          // Private mode / blocked storage: fall back to memory so the app still works.
          const mem = new Map<string, string>();
          return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
        }
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PrefsState>;
        return {
          ...current,
          ...p,
          appearance: { ...current.appearance, ...p.appearance },
          typography: { ...current.typography, ...p.typography },
          shortcuts: { ...current.shortcuts, ...p.shortcuts },
        };
      },
    },
  ),
);

/* ---------------------------- keyboard combos ---------------------------- */

export function comboFromEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  const isLetter = k.length === 1 && /[a-z]/i.test(k);
  if (e.shiftKey && (isLetter || k.length > 1)) parts.push('Shift');
  parts.push(k === ' ' ? 'Space' : k.length === 1 ? k.toUpperCase() : k);
  return parts.join('+');
}

export function prettyCombo(combo: string): string {
  if (!combo) return '—';
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return combo
    .split('+')
    .map((p) =>
      p === 'Mod'
        ? mac
          ? '⌘'
          : 'Ctrl'
        : p === 'Shift'
          ? mac
            ? '⇧'
            : 'Shift'
          : p === 'Alt'
            ? mac
              ? '⌥'
              : 'Alt'
            : ({ ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space' } as Record<string, string>)[p] ?? p,
    )
    .join(mac ? '' : '+');
}
