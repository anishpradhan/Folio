import { Fragment, type ReactNode } from 'react';
import type { AnswerCitation } from './api';

/**
 * Rendering an answer: a small Markdown subset (paragraphs, bullet and numbered lists, headings, bold,
 * italics, inline code) with citation chips placed where each cited span of text ends.
 *
 * Everything becomes React elements — model output is never injected as HTML, and Markdown links are
 * shown as their text only.
 */

export type Inline = { kind: 'text'; text: string } | { kind: 'cite'; citations: AnswerCitation[] };
export type Block = { kind: 'p' | 'ul' | 'ol' | 'h'; inlines: Inline[] };

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const HEADING = /^\s*#{1,6}\s+/;

/** Where a citation's chip goes: the end of its span, pulled back over trailing whitespace. */
export function chipOffset(text: string, c: Pick<AnswerCitation, 'start' | 'end'>): number {
  let p = Math.max(0, Math.min(c.end, text.length));
  while (p > Math.max(0, c.start) && /\s/.test(text[p - 1])) p--;
  return p;
}

/** Split an answer into blocks, with chips inserted at their offsets. Pure: unit-tested. */
export function segmentAnswer(text: string, citations: AnswerCitation[]): Block[] {
  const points = new Map<number, AnswerCitation[]>();
  for (const c of citations) {
    const p = chipOffset(text, c);
    const list = points.get(p) ?? [];
    if (!list.some((x) => x.page === c.page && x.quote === c.quote)) list.push(c);
    points.set(p, list);
  }
  const offsets = [...points.keys()].sort((a, b) => a - b);
  const used = new Set<number>();

  const blocks: Block[] = [];
  let para: Block | null = null;
  let pos = 0;
  for (const line of text.split('\n')) {
    const ls = pos;
    const le = pos + line.trimEnd().length; // content end; trailing spaces carry nothing
    pos += line.length + 1;
    if (!line.trim()) {
      para = null;
      continue;
    }
    const marker = line.match(BULLET) ?? line.match(NUMBERED) ?? line.match(HEADING);
    const kind: Block['kind'] = BULLET.test(line) ? 'ul' : NUMBERED.test(line) ? 'ol' : HEADING.test(line) ? 'h' : 'p';
    const cs = ls + (marker ? marker[0].length : 0);

    const inlines: Inline[] = [];
    let cursor = cs;
    for (const p of offsets) {
      // Earlier lines consumed every chip up to their end, so an unused chip at or before this line's end
      // belongs here (one inside a list marker moves to where the item's text starts).
      if (used.has(p) || p > le) continue;
      const at = Math.max(p, cs);
      if (at > cursor) inlines.push({ kind: 'text', text: text.slice(cursor, at) });
      inlines.push({ kind: 'cite', citations: points.get(p)! });
      used.add(p);
      cursor = Math.max(cursor, at);
    }
    if (le > cursor) inlines.push({ kind: 'text', text: text.slice(cursor, le) });

    if (kind === 'p' && para) {
      para.inlines.push({ kind: 'text', text: ' ' }, ...inlines); // a soft line break inside a paragraph
    } else {
      const b: Block = { kind, inlines };
      blocks.push(b);
      para = kind === 'p' ? b : null;
    }
  }
  // Chips that point past the last line (e.g. an empty answer) still show.
  const rest = offsets.filter((p) => !used.has(p));
  if (rest.length) {
    const tail = blocks[blocks.length - 1] ?? (blocks.push({ kind: 'p', inlines: [] }), blocks[0]);
    for (const p of rest) tail.inlines.push({ kind: 'cite', citations: points.get(p)! });
  }
  return blocks;
}

/* ------------------------------ inline Markdown ------------------------------ */

// Inline math ($d_k$, $$...$$) shows as italic text: models write LaTeX even when asked not to. A `$` must
// hug its content and not precede a digit, so prices ("$5 and $10") stay as they are.
const TOKEN = /(\$\$[^$\n]+\$\$|\$(?=\S)[^$\n]*?\S\$(?!\d)|\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_|\[[^\]\n]+\]\([^)\s]+\))/g;

/** "\\sqrt{d_k}" -> "√d_k": the few LaTeX commands answers about papers commonly use, as plain text. */
export function plainMath(tex: string): string {
  return tex
    .replace(/\\sqrt\{([^}]*)\}/g, '√$1')
    .replace(/\\(?:frac)\{([^}]*)\}\{([^}]*)\}/g, '$1/$2')
    .replace(/\\(times|cdot)\b/g, (_, c: string) => (c === 'times' ? '×' : '·'))
    .replace(/\\(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|sigma|pi)\b/g, (_, g: string) => ({ alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ', pi: 'π' })[g] ?? g)
    .replace(/\\(?:text|mathrm|mathbf|operatorname)\{([^}]*)\}/g, '$1')
    .replace(/[{}]/g, '');
}

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const t = m[0];
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    if (t.startsWith('$$')) out.push(<em key={i} className="font-serif">{plainMath(t.slice(2, -2))}</em>);
    else if (t.startsWith('$')) out.push(<em key={i} className="font-serif">{plainMath(t.slice(1, -1))}</em>);
    else if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={i}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={i} className="rounded bg-ink/[0.06] px-1 font-mono text-[0.92em]">{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) out.push(t.slice(1, t.indexOf(']'))); // link text only
    else out.push(<em key={i}>{t.slice(1, -1)}</em>);
    last = i + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ------------------------------ component ------------------------------ */

export function AnswerText({ text, citations, renderChip }: { text: string; citations: AnswerCitation[]; renderChip: (c: AnswerCitation, key: string) => ReactNode }) {
  const blocks = segmentAnswer(text, citations);
  const inlines = (b: Block) =>
    b.inlines.map((x, i) => (x.kind === 'text' ? <Fragment key={i}>{renderInline(x.text)}</Fragment> : <Fragment key={i}>{x.citations.map((c, k) => renderChip(c, `${i}-${k}`))}</Fragment>));

  // Consecutive list items render as one list.
  const out: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === 'ul' || b.kind === 'ol') {
      const items: Block[] = [];
      while (i < blocks.length && blocks[i].kind === b.kind) items.push(blocks[i++]);
      i--;
      const List = b.kind === 'ul' ? 'ul' : 'ol';
      out.push(
        <List key={`l${i}`} className={b.kind === 'ul' ? 'list-disc space-y-1 pl-5' : 'list-decimal space-y-1 pl-5'}>
          {items.map((it, k) => (
            <li key={k}>{inlines(it)}</li>
          ))}
        </List>,
      );
    } else if (b.kind === 'h') {
      out.push(
        <p key={i} className="font-semibold text-ink">
          {inlines(b)}
        </p>,
      );
    } else {
      out.push(<p key={i}>{inlines(b)}</p>);
    }
  }
  return <div className="space-y-2.5">{out}</div>;
}
