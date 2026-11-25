/**
 * Turns pdf.js text items into page text that preserves reading order, line ends and
 * paragraph breaks. Pure and DOM-free so it can run in a worker or on a server later
 * (the same output feeds search, reflow view and, eventually, RAG chunking).
 */

export interface TextItemLike {
  str: string;
  hasEOL?: boolean;
  /** pdf.js transform [a, b, c, d, e, f]; f is the baseline y (PDF space, bottom-up). */
  transform?: number[];
  height?: number;
}

/**
 * Build the page text. Items are concatenated exactly as the text layer renders them
 * (so DOM search mapping stays consistent); a line end becomes "\n" and a line that starts
 * after an unusually large vertical gap becomes a paragraph break "\n\n".
 */
export function buildPageText(items: TextItemLike[]): string {
  // Pass 1: split into lines with their baseline y and dominant font height.
  type Line = { text: string; y: number | null; h: number };
  const lines: Line[] = [];
  let cur: Line = { text: '', y: null, h: 0 };
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    if (it.str.length && it.transform) {
      if (cur.y === null) cur.y = it.transform[5];
      cur.h = Math.max(cur.h, it.height ?? Math.abs(it.transform[3]) ?? 0);
    }
    cur.text += it.str;
    if (it.hasEOL) {
      lines.push(cur);
      cur = { text: '', y: null, h: 0 };
    }
  }
  if (cur.text.length) lines.push(cur);
  if (!lines.length) return '';

  // Typical line spacing = median of positive baseline gaps.
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1].y,
      b = lines[i].y;
    if (a !== null && b !== null && a - b > 0) gaps.push(a - b);
  }
  gaps.sort((x, y) => x - y);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

  let out = lines[0].text;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1],
      line = lines[i];
    let sep = '\n';
    if (typical > 0 && prev.y !== null && line.y !== null) {
      const gap = prev.y - line.y;
      // Large gap, or moving upward (new column) → paragraph boundary.
      if (gap > typical * 1.45 || gap < -typical) sep = '\n\n';
    }
    if (!prev.text.trim()) sep = '\n\n';
    out += sep + line.text;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Paragraphs for reflowable presentation: joins wrapped lines and repairs hyphenation. */
export function toParagraphs(pageText: string): string[] {
  return pageText
    .split(/\n{2,}/)
    .map((p) =>
      p
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .reduce((acc, line) => {
          if (!acc) return line;
          // "inter-\nnational" → "international" (only when the next line starts lower-case)
          if (/[a-z]-$/.test(acc) && /^[a-z]/.test(line)) return acc.slice(0, -1) + line;
          return `${acc} ${line}`;
        }, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}
