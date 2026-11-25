import type { OutlineNode } from './types';

/** Flatten an outline into document order with depths. */
export function flattenOutline(nodes: OutlineNode[], depth = 0, out: { node: OutlineNode; depth: number }[] = []) {
  for (const n of nodes) {
    out.push({ node: n, depth });
    flattenOutline(n.children, depth + 1, out);
  }
  return out;
}

/** The section that contains `page`: the last outline entry (in document order) starting on or before it. */
export function sectionForPage(nodes: OutlineNode[], page: number): OutlineNode | null {
  const flat = flattenOutline(nodes).filter((f) => f.node.page != null);
  let best: { node: OutlineNode; depth: number } | null = null;
  for (const f of flat) {
    const p = f.node.page as number;
    if (p > page) continue;
    const bp = best ? (best.node.page as number) : -1;
    // Later start wins; on the same start, the deeper (more specific) entry wins.
    if (!best || p > bp || (p === bp && f.depth >= best.depth)) best = f;
  }
  return best?.node ?? null;
}
