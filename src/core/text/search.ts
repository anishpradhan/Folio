/**
 * Search primitives shared by the in-document search panel (over stored page text)
 * and the page overlay (over the live text-layer DOM).
 *
 * Both sides fold their text the same way — lower-case, whitespace runs collapsed to one
 * space, soft hyphens dropped — and keep a map back to the original offsets.
 */

export interface Folded {
  text: string;
  /** map[i] = index in the source string of folded char i (or -1 for virtual separators). */
  map: number[];
}

const WS = /\s/;

function foldChar(c: string): string {
  const l = c.toLowerCase();
  if (l.length !== 1) return c;
  // Strip diacritics for single chars when that stays a single char (é → e).
  const n = l.normalize('NFD');
  return n.length > 1 && /[̀-ͯ]/.test(n.slice(1)) ? n[0] : l;
}

export function fold(source: string): Folded {
  let text = '';
  const map: number[] = [];
  let lastWasSpace = true; // trims leading whitespace
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '­') continue;
    if (WS.test(c)) {
      if (!lastWasSpace) {
        text += ' ';
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    text += foldChar(c);
    map.push(i);
    lastWasSpace = false;
  }
  return { text, map };
}

export function foldQuery(q: string): string {
  return fold(q).text.trim();
}

/** All non-overlapping occurrences of `query` (already folded) in folded text. */
export function findAll(foldedText: string, foldedQuery: string, limit = 5000): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  if (!foldedQuery) return out;
  let from = 0;
  while (out.length < limit) {
    const i = foldedText.indexOf(foldedQuery, from);
    if (i < 0) break;
    out.push({ start: i, end: i + foldedQuery.length });
    from = i + foldedQuery.length;
  }
  return out;
}

export interface SearchHit {
  page: number;
  /** Index of this hit among the hits on the same page. */
  indexOnPage: number;
  /** Global index across the document. */
  index: number;
  before: string;
  match: string;
  after: string;
}

/** Search a document's page texts. Snippets are taken from the original (unfolded) text. */
export function searchPages(pages: { page: number; text: string }[], query: string, maxHits = 2000): SearchHit[] {
  const q = foldQuery(query);
  if (q.length < 1) return [];
  const hits: SearchHit[] = [];
  for (const p of pages) {
    const f = fold(p.text);
    const matches = findAll(f.text, q);
    matches.forEach((m, k) => {
      const s = f.map[m.start];
      const e = f.map[m.end - 1] + 1;
      const tidy = (x: string) => x.replace(/\s+/g, ' ');
      const beforeRaw = p.text.slice(Math.max(0, s - 70), s);
      const afterRaw = p.text.slice(e, e + 90);
      hits.push({
        page: p.page,
        indexOnPage: k,
        index: hits.length,
        before: (s > 70 ? '…' : '') + tidy(beforeRaw).replace(/^\S*\s/, s > 70 ? '' : '$&').trimStart(),
        match: tidy(p.text.slice(s, e)),
        after: tidy(afterRaw) + (e + 90 < p.text.length ? '…' : ''),
      });
    });
    if (hits.length >= maxHits) break;
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * DOM side: locate matches inside a rendered pdf.js text layer.
 * ------------------------------------------------------------------ */

export interface DomTextIndex {
  folded: Folded;
  /** Parallel to the unfolded source string: which text node + offset each char came from. */
  nodes: { node: Text; offset: number }[];
}

/**
 * Walk a text layer in document order. Text nodes are concatenated; each <br> (pdf.js line end)
 * contributes a virtual "\n" — mirroring how page text is stored.
 */
export function indexTextLayer(layer: HTMLElement): DomTextIndex {
  let source = '';
  const nodes: { node: Text; offset: number }[] = [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n: Node | null = walker.nextNode();
  while (n) {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n as Text;
      const s = t.data;
      for (let i = 0; i < s.length; i++) nodes.push({ node: t, offset: i });
      source += s;
    } else if ((n as Element).tagName === 'BR') {
      source += '\n';
      nodes.push(nodes[nodes.length - 1] ?? { node: document.createTextNode(''), offset: 0 });
    }
    n = walker.nextNode();
  }
  return { folded: fold(source), nodes };
}

/** DOM Range covering folded [start, end) in the index. */
export function rangeFor(idx: DomTextIndex, start: number, end: number): Range | null {
  const a = idx.nodes[idx.folded.map[start]];
  const b = idx.nodes[idx.folded.map[end - 1]];
  if (!a || !b) return null;
  const r = document.createRange();
  try {
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset + 1);
  } catch {
    return null;
  }
  return r;
}
