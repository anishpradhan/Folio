import { fold, type Folded } from './search';

/**
 * Text indexing for reflowable HTML (EPUB sections and the PDF text view).
 *
 * One walk produces both the stored section text (used by search and future chunking) and a map
 * from every character back to its DOM text node, so search hits and highlights found in the
 * stored text can be located — and marked — in the rendered DOM.
 */

const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'CAPTION', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

export interface HtmlTextIndex {
  /** Raw text: text nodes in order, with "\n" at block boundaries. */
  source: string;
  folded: Folded;
  /** Parallel to `source`; null for virtual block separators. */
  nodes: ({ node: Text; offset: number } | null)[];
}

export function indexHtml(root: Node): HtmlTextIndex {
  let source = '';
  const nodes: HtmlTextIndex['nodes'] = [];
  const sep = () => {
    if (source && !source.endsWith('\n')) {
      source += '\n';
      nodes.push(null);
    }
  };
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      const t = n as Text;
      for (let i = 0; i < t.data.length; i++) nodes.push({ node: t, offset: i });
      source += t.data;
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 11 && n.nodeType !== 9) return;
    const tag = (n as Element).tagName?.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'RT' || tag === 'RP') return;
    const block = tag ? BLOCK.has(tag) : false;
    if (block) sep();
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    if (block) sep();
  };
  walk(root);
  return { source, folded: fold(source), nodes };
}

/** Stored text for a section: block boundaries become line breaks, blank runs collapse. */
export function htmlText(root: Node): string {
  return indexHtml(root)
    .source.replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface Segment {
  node: Text;
  start: number;
  end: number;
}

/** Text-node segments covering folded [start, end). */
export function segmentsFor(idx: HtmlTextIndex, start: number, end: number): Segment[] {
  const from = idx.folded.map[start];
  const to = idx.folded.map[end - 1];
  if (from === undefined || to === undefined) return [];
  const out: Segment[] = [];
  for (let i = from; i <= to; i++) {
    const loc = idx.nodes[i];
    if (!loc) continue;
    const last = out[out.length - 1];
    if (last && last.node === loc.node && last.end === loc.offset) last.end++;
    else out.push({ node: loc.node, start: loc.offset, end: loc.offset + 1 });
  }
  return out;
}

/** Folded offset of a DOM position (e.g. a selection boundary), or -1. */
export function foldedOffsetOf(idx: HtmlTextIndex, node: Node, offset: number): number {
  let src = -1;
  if (node.nodeType === 3) {
    src = idx.nodes.findIndex((l) => l && l.node === node && l.offset >= offset);
  } else {
    // Element boundary: first text position at or after the child at `offset`.
    const child = node.childNodes[offset] ?? null;
    src = idx.nodes.findIndex((l) => l && (child ? child === l.node || child.contains(l.node) || !!(child.compareDocumentPosition(l.node) & Node.DOCUMENT_POSITION_FOLLOWING) : false));
  }
  if (src < 0) return -1;
  const f = idx.folded.map.findIndex((m) => m >= src);
  return f;
}

/**
 * Wrap segments in elements. Segments are applied last-to-first so splitting a text node never
 * invalidates the offsets of segments still to be wrapped.
 */
export function wrapSegments(groups: { segments: Segment[]; make: () => HTMLElement }[]) {
  type Job = { seg: Segment; make: () => HTMLElement; order: number };
  const jobs: Job[] = [];
  const order = new Map<Text, number>();
  groups.forEach((g) =>
    g.segments.forEach((seg) => {
      if (!order.has(seg.node)) order.set(seg.node, order.size);
      jobs.push({ seg, make: g.make, order: 0 });
    }),
  );
  // Document order of text nodes.
  const nodesSorted = [...order.keys()].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  nodesSorted.forEach((n, i) => order.set(n, i));
  jobs.forEach((j) => (j.order = order.get(j.seg.node)!));
  jobs.sort((a, b) => b.order - a.order || b.seg.start - a.seg.start);
  for (const { seg, make } of jobs) {
    let t = seg.node;
    if (!t.parentNode) continue;
    if (seg.end < t.data.length) t.splitText(seg.end);
    if (seg.start > 0) t = t.splitText(seg.start);
    const el = make();
    t.parentNode!.insertBefore(el, t);
    el.appendChild(t);
  }
}
