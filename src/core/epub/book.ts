import { strFromU8 } from 'fflate';
import { mediaTypeOf, parseEpub, parseXml, readFile, type EpubPackage } from './epub';
import { sanitizeSection } from './sanitize';

/**
 * An opened EPUB: sections rendered on demand as sanitised HTML, images served from the zip via
 * object URLs (revoked on destroy). Sections are addressed 1-based, like PDF pages.
 */
export interface EpubBook {
  pkg: EpubPackage;
  sectionCount: number;
  /** Sanitised HTML for a section (cached). */
  sectionHtml: (page: number) => string;
  /** Raw size of a section's markup in bytes — a cheap length estimate before it is rendered. */
  sectionSize: (page: number) => number;
  destroy: () => void;
}

export function sectionIndexer(pkg: EpubPackage) {
  const map = new Map(pkg.spine.map((p, i) => [p.toLowerCase(), i + 1]));
  return (path: string) => map.get(path.toLowerCase()) ?? null;
}

/** Parse + sanitise one section into a detached element (used for rendering and text extraction). */
export function sectionElement(pkg: EpubPackage, page: number, image: (path: string) => string | null): HTMLElement {
  const path = pkg.spine[page - 1];
  const bytes = path ? readFile(pkg.files, path) : undefined;
  if (!bytes) return document.createElement('div');
  const doc = parseXml(strFromU8(bytes), /\.html?$/i.test(path) ? 'text/html' : 'application/xhtml+xml');
  return sanitizeSection(doc, { path, image, section: sectionIndexer(pkg) });
}

export function openEpub(bytes: Uint8Array): EpubBook {
  const pkg = parseEpub(bytes);
  const urls = new Map<string, string>();
  const cache = new Map<number, string>();
  const image = (path: string) => {
    const hit = urls.get(path);
    if (hit) return hit;
    const data = readFile(pkg.files, path);
    if (!data) return null;
    const url = URL.createObjectURL(new Blob([data], { type: mediaTypeOf(pkg, path) }));
    urls.set(path, url);
    return url;
  };
  return {
    pkg,
    sectionCount: pkg.spine.length,
    sectionHtml(page) {
      let html = cache.get(page);
      if (html === undefined) {
        html = sectionElement(pkg, page, image).innerHTML;
        cache.set(page, html);
      }
      return html;
    },
    sectionSize(page) {
      const path = pkg.spine[page - 1];
      return (path && readFile(pkg.files, path)?.length) || 0;
    },
    destroy() {
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls.clear();
      cache.clear();
    },
  };
}
