import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { useReader } from './store';
import { usePrefs, type Appearance, type ReadingFont, type Typography } from '../../state/prefs';
import { getPageText } from '../../data/repo';
import { getPageTextLive } from '../../core/pdf/textCache';
import { toParagraphs } from '../../core/text/structure';
import type { DocumentRecord, Highlight } from '../../core/types';
import { clamp } from '../../lib/util';
import { Spinner } from '../../components/ui';

export const FONT_STACKS: Record<ReadingFont, { label: string; stack: string }> = {
  literata: { label: 'Literata', stack: "'Literata Variable', Georgia, serif" },
  garamond: { label: 'EB Garamond', stack: "'EB Garamond', Garamond, Georgia, serif" },
  fraunces: { label: 'Fraunces', stack: "'Fraunces Variable', Georgia, serif" },
  atkinson: { label: 'Atkinson Hyperlegible', stack: "'Atkinson Hyperlegible', system-ui, sans-serif" },
  instrument: { label: 'Instrument Sans', stack: "'Instrument Sans Variable', system-ui, sans-serif" },
};

/** Mark highlight texts inside a paragraph (first occurrence of each). */
function markParagraph(text: string, highlights: Highlight[]): ReactNode {
  type Span = { start: number; end: number; h: Highlight };
  const spans: Span[] = [];
  for (const h of highlights) {
    const needle = h.text.replace(/\s+/g, ' ').trim();
    if (needle.length < 2) continue;
    const i = text.indexOf(needle);
    if (i >= 0 && !spans.some((s) => i < s.end && i + needle.length > s.start)) spans.push({ start: i, end: i + needle.length, h });
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a.start - b.start);
  const out: ReactNode[] = [];
  let at = 0;
  spans.forEach((s, k) => {
    if (s.start > at) out.push(text.slice(at, s.start));
    out.push(
      <mark key={k} data-hl={s.h.id} className={`hl-${s.h.color} cursor-pointer`}>
        {text.slice(s.start, s.end)}
      </mark>,
    );
    at = s.end;
  });
  out.push(text.slice(at));
  return out;
}

/**
 * Text view: the page's extracted text re-flowed with the reader's typography settings.
 * The original PDF is untouched; this is an alternate presentation of the same content.
 */
export function ReflowView({ doc }: { doc: DocumentRecord }) {
  const pdf = useReader((s) => s.pdf)!;
  const page = useReader((s) => s.page);
  const set = useReader((s) => s.set);
  const highlights = useReader((s) => s.highlights);
  const typo = usePrefs((s) => s.typography);
  const appearance = usePrefs((s) => s.appearance);
  const dark = appearance.invert;
  const [text, setText] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prev = useRef(page);
  const dir = page >= prev.current ? 'turn-next' : 'turn-prev';
  useEffect(() => {
    prev.current = page;
  });

  useEffect(() => {
    set({
      nav: {
        goTo: (p) => {
          set({ page: clamp(Math.round(p), 1, doc.pageCount), offset: 0 });
          scrollRef.current?.scrollTo({ top: 0 });
        },
      },
    });
  }, [doc.pageCount, set]);

  useEffect(() => {
    let alive = true;
    setText(null);
    (async () => {
      const stored = await getPageText(doc.id, page);
      const t = stored?.text ?? (await getPageTextLive(pdf, page));
      if (alive) setText(t);
    })().catch(() => alive && setText(''));
    return () => {
      alive = false;
    };
  }, [doc.id, page, pdf]);

  // Drop running page numbers ("12", "iv") that PDFs carry as stray paragraphs.
  const paragraphs = useMemo(() => {
    if (!text) return [];
    const label = doc.pageLabels?.[page - 1] ?? String(page);
    return toParagraphs(text).filter((p) => p !== label && p !== String(page) && !/^[-–—\s]*\d{1,4}[-–—\s]*$/.test(p));
  }, [text, doc.pageLabels, page]);
  const pageHighlights = useMemo(() => highlights.filter((h) => h.page === page), [highlights, page]);

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-3 py-6 sm:px-8 sm:py-10" data-testid="reflow-scroll">
      <div
        className="relative mx-auto overflow-hidden rounded-[3px] px-6 pt-10 pb-16 sm:px-14"
        style={sheetStyle(appearance, typo)}
      >
        <div className="page-overlay page-texture" />
        <div className="mb-8 flex items-center justify-between text-[12px]" style={{ color: dark ? '#9b968c' : 'var(--ink-3)' }}>
          <span className="eyebrow" style={{ color: 'inherit' }}>
            Text view · Page {page}
          </span>
          <span className="italic">Original layout preserved in the PDF view</span>
        </div>
        {text === null ? (
          <div className="grid h-40 place-items-center text-ink-3">
            <Spinner />
          </div>
        ) : paragraphs.length ? (
          <article
            key={page}
            className={`reflow ${dir}`}
            data-page={page}
            style={typographyVars(typo, dark)}
          >
            {paragraphs.map((p, i) => (
              <p key={i}>{markParagraph(p, pageHighlights)}</p>
            ))}
          </article>
        ) : (
          <div className="grid place-items-center gap-2 py-16 text-center text-ink-3">
            <FileText size={22} />
            <p className="max-w-[34ch] text-[13.5px]">This page has no selectable text — it may be an image or a scan. Switch back to the original layout to see it.</p>
          </div>
        )}
        <nav className="mt-14 flex items-center justify-between" aria-label="Page navigation">
          <button className="btn btn-ghost" disabled={page <= 1} onClick={() => useReader.getState().nav?.goTo(page - 1)}>
            <ChevronLeft size={16} /> Previous
          </button>
          <span className="text-[12px] text-ink-3 tabular-nums">
            {page} / {doc.pageCount}
          </span>
          <button className="btn btn-ghost" disabled={page >= doc.pageCount} onClick={() => useReader.getState().nav?.goTo(page + 1)}>
            Next <ChevronRight size={16} />
          </button>
        </nav>
      </div>
    </div>
  );
}

/** The reading sheet follows the page appearance (warmth, sepia, dark, shadow) without filtering text. */
export function sheetStyle(appearance: Appearance, typo: Typography): React.CSSProperties {
  const paper = appearance.invert ? '#211f1c' : `color-mix(in srgb, #fffdf9, #f3dfbd ${Math.round(appearance.warmth * 0.6 + appearance.sepia * 0.7)}%)`;
  return {
    maxWidth: typo.width + 112,
    background: paper,
    boxShadow: `0 0 0 1px rgb(var(--page-shadow) / calc(var(--shadow-k) * 0.1)), 0 18px 40px -18px rgb(var(--page-shadow) / calc(var(--shadow-k) * 0.6))`,
  };
}

export function typographyVars(typo: Typography, dark: boolean): React.CSSProperties {
  return {
    '--reflow-font': FONT_STACKS[typo.font].stack,
    '--reflow-size': `${typo.size}px`,
    '--reflow-lh': typo.lineHeight,
    '--reflow-ls': `${typo.letterSpacing}em`,
    '--reflow-ps': `${typo.paragraphSpacing}em`,
    '--reflow-align': typo.align,
    '--reflow-ink': dark ? '#e9e3d6' : 'var(--ink)',
  } as React.CSSProperties;
}
