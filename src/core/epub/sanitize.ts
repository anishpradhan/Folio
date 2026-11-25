import { resolvePath } from './epub';

/**
 * EPUB content documents are untrusted HTML. Rather than injecting them, we rebuild each section
 * from an allowlist: structural and inline text elements, images and links only. Scripts, styles,
 * forms, embeds, event handlers and javascript: URLs never make it through. Publisher CSS is not
 * applied — the reader's own typography governs every book consistently.
 */

const ALLOWED = new Set([
  'p', 'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'em', 'i',
  'strong', 'b', 'u', 's', 'sub', 'sup', 'small', 'br', 'hr', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'caption', 'figure', 'figcaption', 'img', 'a', 'abbr', 'cite', 'q', 'time', 'ruby', 'rt', 'rp', 'del', 'ins', 'var', 'kbd', 'samp', 'mark', 'bdi', 'bdo', 'wbr',
]);
/** Dropped together with their content. */
const DROP = new Set(['script', 'style', 'link', 'meta', 'title', 'head', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'template', 'noscript', 'canvas', 'audio', 'video', 'source', 'track', 'math', 'base']);

export interface SanitizeOptions {
  /** Zip path of the section being sanitised (for resolving relative URLs). */
  path: string;
  /** Return a usable URL for an image inside the book, or null to drop it. */
  image: (zipPath: string) => string | null;
  /** Map an internal link to a spine section (1-based) or null when it's outside the spine. */
  section: (zipPath: string) => number | null;
}

/** Prefix for element ids from the book, so they can't collide with the app's own ids. */
export const ID_PREFIX = 'ep-';

export function sanitizeSection(src: Document, opts: SanitizeOptions): HTMLElement {
  const out = document.implementation.createHTMLDocument('');
  const root = out.createElement('div');

  const copy = (from: Node, to: Node) => {
    for (let n = from.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        to.appendChild(out.createTextNode((n as Text).data));
        continue;
      }
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      const tag = el.localName.toLowerCase();
      if (DROP.has(tag)) continue;

      // <svg><image href="cover.jpg"/></svg> — common for cover pages: keep the picture.
      if (tag === 'svg') {
        const image = Array.from(el.getElementsByTagNameNS('*', 'image'))[0];
        const href = image?.getAttribute('href') ?? image?.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        const url = href ? opts.image(resolvePath(opts.path, href).path) : null;
        if (url) {
          const img = out.createElement('img');
          img.setAttribute('src', url);
          img.setAttribute('alt', '');
          to.appendChild(img);
        }
        continue;
      }

      if (!ALLOWED.has(tag)) {
        copy(el, to); // unknown wrapper (body, font, center, epub-specific…) → keep its content
        continue;
      }

      const clean = out.createElement(tag);
      const id = el.getAttribute('id');
      if (id) clean.setAttribute('id', ID_PREFIX + id);
      for (const attr of ['lang', 'dir', 'title']) {
        const v = el.getAttribute(attr);
        if (v) clean.setAttribute(attr, v);
      }
      const epubType = el.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? el.getAttribute('epub:type');
      if (epubType) clean.setAttribute('data-epub-type', epubType);

      if (tag === 'img') {
        const s = el.getAttribute('src');
        const url = s ? opts.image(resolvePath(opts.path, s).path) : null;
        if (!url) continue;
        clean.setAttribute('src', url);
        clean.setAttribute('alt', el.getAttribute('alt') ?? '');
        clean.setAttribute('loading', 'lazy');
      } else if (tag === 'a') {
        const href = el.getAttribute('href')?.trim() ?? '';
        if (/^(https?:|mailto:)/i.test(href)) {
          clean.setAttribute('href', href);
          clean.setAttribute('target', '_blank');
          clean.setAttribute('rel', 'noopener noreferrer');
        } else if (href.startsWith('#')) {
          clean.setAttribute('href', '#');
          clean.setAttribute('data-anchor', href.slice(1));
        } else if (href && !/^[a-z]+:/i.test(href)) {
          const target = resolvePath(opts.path, href);
          const page = opts.section(target.path);
          if (page) {
            clean.setAttribute('href', '#');
            clean.setAttribute('data-section', String(page));
            if (target.fragment) clean.setAttribute('data-anchor', target.fragment);
          }
        }
      } else if (tag === 'td' || tag === 'th') {
        for (const attr of ['colspan', 'rowspan']) {
          const v = el.getAttribute(attr);
          if (v && /^\d+$/.test(v)) clean.setAttribute(attr, v);
        }
      } else if (tag === 'ol') {
        const v = el.getAttribute('start');
        if (v && /^-?\d+$/.test(v)) clean.setAttribute('start', v);
      }
      copy(el, clean);
      to.appendChild(clean);
    }
  };

  const body = src.body ?? src.getElementsByTagNameNS('*', 'body')[0] ?? src.documentElement;
  copy(body, root);
  return root;
}
