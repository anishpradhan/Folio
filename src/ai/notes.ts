import { chipOffset, plainMath } from './answer';
import type { AnswerCitation, AskMode } from './api';
import { addHighlight, addNote, deleteHighlight, deleteJournal, deleteNote, saveJournal } from '../data/repo';
import type { DocumentRecord, Highlight, HighlightColor, JournalEntry, NormRect, PageNote } from '../core/types';

/**
 * Saving an answer to the reader's own notes (phase 6): a highlight with the explanation as its note, a page
 * note, or a journal entry. Everything goes through the existing repo functions, so it shows in the notebook,
 * Insights, the Journal and the Markdown export like anything written by hand.
 */

/** An answer as plain note text: each citation becomes a page reference where its chip was, e.g. "(p. 4)". */
export function answerAsNote(text: string, citations: AnswerCitation[], ref: (page: number) => string): string {
  const points = new Map<number, number[]>();
  for (const c of citations) {
    const p = chipOffset(text, c);
    const pages = points.get(p) ?? [];
    if (!pages.includes(c.page)) pages.push(c.page);
    points.set(p, pages);
  }
  let out = text;
  for (const p of [...points.keys()].sort((a, b) => b - a)) {
    const pages = points.get(p)!.sort((a, b) => a - b);
    out = `${out.slice(0, p)} (${pages.map(ref).join(', ')})${out.slice(p)}`;
  }
  // Notes are plain text: drop Markdown emphasis, heading marks and link targets; write math as text.
  return out
    .split('\n')
    .map((l) => l.replace(/^\s*#{1,6}\s+/, ''))
    .join('\n')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, '$1$2')
    .replace(/\$\$([^$\n]+)\$\$/g, (_, m: string) => plainMath(m))
    .replace(/\$(?=\S)([^$\n]*?\S)\$(?!\d)/g, (_, m: string) => plainMath(m))
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SavableAnswer {
  mode: AskMode;
  /** The reader's question (chat and ask); empty for explain/summarize/simplify. */
  question: string;
  /** The selected text the answer is about, if any. */
  selection?: string;
  selectionPage?: number | null;
  text: string;
  citations: AnswerCitation[];
}

const MODE_TITLES: Partial<Record<AskMode, string>> = { explain: 'Explanation', summarize: 'Summary', simplify: 'In plain words' };

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

/** Title, body and page for a page note or journal entry made from an answer. Pure: unit-tested. */
export function describeAnswer(a: SavableAnswer, ref: (page: number) => string): { title: string; body: string; page: number | null } {
  const label = MODE_TITLES[a.mode];
  const title = label ? `${label}: “${clip(a.selection ?? '', 60)}”` : clip(a.question, 120);
  const answer = answerAsNote(a.text, a.citations, ref);
  const quoted = a.selection ? `“${clip(a.selection, 400)}”` : '';
  const body = [quoted, answer].filter(Boolean).join('\n\n');
  const page = a.citations[0]?.page ?? a.selectionPage ?? null;
  return { title, body, page };
}

export type SavedTo = 'highlight' | 'note' | 'journal';
export interface Saved {
  kind: SavedTo;
  undo: () => Promise<void>;
}

/** A part of the selection as stored with a highlight. */
export interface SelectionPartLike {
  page: number;
  text: string;
  rects: NormRect[];
  anchor?: { start: number; end: number };
}

/** Highlight the selection (every page it spans) with the answer as the first part's note. */
export async function saveAsHighlight(doc: DocumentRecord, parts: SelectionPartLike[], a: SavableAnswer, ref: (page: number) => string, color: HighlightColor = 'yellow'): Promise<Saved & { highlights: Highlight[] }> {
  const note = answerAsNote(a.text, a.citations, ref);
  const highlights: Highlight[] = [];
  for (const [i, part] of parts.entries())
    highlights.push(await addHighlight({ docId: doc.id, page: part.page, color, text: part.text, rects: part.rects, anchor: part.anchor, note: i === 0 ? note : '' }));
  return { kind: 'highlight', highlights, undo: async () => void (await Promise.all(highlights.map((h) => deleteHighlight(h.id)))) };
}

/** A page note on the first cited page (else the selection's page, else `fallbackPage`). */
export async function saveAsPageNote(doc: DocumentRecord, a: SavableAnswer, ref: (page: number) => string, fallbackPage: number): Promise<Saved & { note: PageNote }> {
  const d = describeAnswer(a, ref);
  const note = await addNote(doc.id, d.page ?? fallbackPage, `${d.title}\n\n${d.body}`);
  return { kind: 'note', note, undo: () => deleteNote(note.id) };
}

/** A journal entry for today, linked to the document and page. Summaries are filed as summaries. */
export async function saveToJournal(doc: DocumentRecord, a: SavableAnswer, ref: (page: number) => string): Promise<Saved & { entry: JournalEntry }> {
  const d = describeAnswer(a, ref);
  const entry = await saveJournal({ kind: a.mode === 'summarize' ? 'summary' : 'thoughts', docId: doc.id, page: d.page, title: d.title, body: d.body });
  return { kind: 'journal', entry, undo: () => deleteJournal(entry.id) };
}
