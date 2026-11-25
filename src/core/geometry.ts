import type { NormRect } from './types';

/**
 * Collect client rects of a range, restricted to text nodes (pdf.js text layers contain
 * absolutely-positioned spans and <br>s whose element boxes must not leak into highlights).
 */
export function textRectsOfRange(range: Range, within: HTMLElement): DOMRect[] {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT);
  let n: Node | null = walker.nextNode();
  while (n) {
    if (range.intersectsNode(n)) {
      const t = n as Text;
      const r = document.createRange();
      const start = n === range.startContainer ? range.startOffset : 0;
      const end = n === range.endContainer ? range.endOffset : t.data.length;
      if (end > start) {
        r.setStart(t, start);
        r.setEnd(t, end);
        for (const rect of Array.from(r.getClientRects())) if (rect.width > 0.5 && rect.height > 0.5) rects.push(rect);
      }
    }
    n = walker.nextNode();
  }
  return rects;
}

/** Convert client rects to page-normalised rects and merge fragments on the same line. */
export function normaliseRects(rects: DOMRect[], pageBox: DOMRect): NormRect[] {
  const raw = rects
    .map((r) => ({
      x: (r.left - pageBox.left) / pageBox.width,
      y: (r.top - pageBox.top) / pageBox.height,
      w: r.width / pageBox.width,
      h: r.height / pageBox.height,
    }))
    .filter((r) => r.w > 0 && r.h > 0 && r.h < 0.25)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return mergeRects(raw);
}

export function mergeRects(rects: NormRect[]): NormRect[] {
  const out: NormRect[] = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    if (last) {
      const sameLine = Math.abs(last.y + last.h / 2 - (r.y + r.h / 2)) < Math.min(last.h, r.h) * 0.5;
      const close = r.x <= last.x + last.w + Math.max(last.h, r.h) * 0.8;
      if (sameLine && close && r.x + r.w >= last.x) {
        const x = Math.min(last.x, r.x);
        const y = Math.min(last.y, r.y);
        const right = Math.max(last.x + last.w, r.x + r.w);
        const bottom = Math.max(last.y + last.h, r.y + r.h);
        out[out.length - 1] = { x, y, w: right - x, h: bottom - y };
        continue;
      }
    }
    out.push({ ...r });
  }
  return out.map((r) => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) }));
}

const round = (v: number) => Math.round(v * 100000) / 100000;

export function pointInRects(x: number, y: number, rects: NormRect[], pad = 0.002): boolean {
  return rects.some((r) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad);
}
