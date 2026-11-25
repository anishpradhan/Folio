import { sniffFormat, FORMATS } from './formats';
import type { DocFormat } from './types';

/**
 * Add-from-link: turn whatever the reader pasted (a PDF link, a paper's landing page, a DOI, an
 * arXiv id…) into a File for the normal ingest pipeline.
 *
 * Downloads go through Folio's server proxy (`/api/fetch`, see server/linkProxy.ts) because most
 * sites don't allow cross-origin downloads. If no proxy is running (a purely static deployment)
 * the browser fetches directly, which works for CORS-friendly hosts only.
 */

const MAX_BYTES = 600 * 1024 * 1024;
const MAX_PAGES = 3; // landing page → (redirect page) → document

export class LinkError extends Error {}

/** Paper metadata gathered from a landing page on the way to the document. */
export interface LinkMeta {
  title?: string;
  authors?: string[];
}

/** Normalise user input to an http(s) URL, or null if it can't be one. */
export function normalizeLink(raw: string): string | null {
  let s = raw.trim().replace(/^<|>$/g, '');
  if (!s || /\s/.test(s)) return null;
  const doi = s.match(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i);
  if (doi) return `https://doi.org/${doi[1]}`;
  const arxiv = s.match(/^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)$/i);
  if (arxiv) return `https://arxiv.org/abs/${arxiv[1]}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(s)) return null; // must at least look like host.tld/…
    s = `https://${s}`;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return rewrite(u).href;
}

/** Known sites whose share/landing links have a predictable download link. */
function rewrite(u: URL): URL {
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'openreview.net' && u.pathname === '/forum' && u.searchParams.get('id')) return new URL(`https://openreview.net/pdf?id=${u.searchParams.get('id')}`);
  if (host === 'drive.google.com') {
    const id = u.pathname.match(/\/file\/d\/([\w-]+)/)?.[1] ?? (u.pathname === '/open' ? u.searchParams.get('id') : null);
    if (id) return new URL(`https://drive.google.com/uc?export=download&id=${id}`);
  }
  if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
    const v = new URL(u);
    v.searchParams.set('dl', '1');
    return v;
  }
  if (host === 'github.com' && /^\/[^/]+\/[^/]+\/blob\//.test(u.pathname)) {
    const v = new URL(u);
    v.searchParams.set('raw', '1');
    return v;
  }
  return u;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m),
  );

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/**
 * Find the document a landing page points at: scholarly `citation_pdf_url` meta (Google Scholar
 * convention — arXiv, ACL, PMLR, most publishers), an alternate PDF link, a meta refresh, or
 * failing those a link that is plainly "the PDF".
 */
export function findDocumentLink(html: string, base: string): { url: string | null; meta: LinkMeta } {
  const abs = (href: string | undefined) => {
    if (!href) return null;
    try {
      const u = new URL(href.trim(), base);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch {
      return null;
    }
  };
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const metaVal = (...names: string[]) => metas.filter((m) => names.includes((m.name ?? m.property ?? '').toLowerCase())).map((m) => m.content?.trim() ?? '').filter(Boolean);

  const meta: LinkMeta = {};
  const title = metaVal('citation_title', 'dc.title')[0];
  if (title) meta.title = title.replace(/\s+/g, ' ');
  const authors = metaVal('citation_author', 'dc.creator');
  if (authors.length) meta.authors = authors;

  const cited = abs(metaVal('citation_pdf_url', 'bepress_citation_pdf_url', 'eprints.document_url', 'wkhealth_pdf_url')[0]);
  if (cited) return { url: cited, meta };

  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (/alternate/i.test(a.rel ?? '') && /application\/(pdf|epub\+zip)/i.test(a.type ?? '')) {
      const u = abs(a.href);
      if (u) return { url: u, meta };
    }
  }

  const refresh = metas.find((m) => (m['http-equiv'] ?? '').toLowerCase() === 'refresh')?.content?.match(/url\s*=\s*['"]?([^'"]+)/i)?.[1];
  if (refresh && abs(refresh)) return { url: abs(refresh), meta };

  let fallback: string | null = null;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a = attrs(m[1]);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const href = abs(a.href);
    if (!href) continue;
    const pdfHref = /\.(pdf|epub)([?#]|$)/i.test(new URL(href).pathname + new URL(href).search);
    if (pdfHref && /\b(pdf|epub|download|full ?text)\b/i.test(`${text} ${a.title ?? ''} ${a['aria-label'] ?? ''}`)) return { url: href, meta };
    fallback ??= pdfHref ? href : null;
  }
  return { url: fallback, meta };
}

interface Downloaded {
  bytes: Uint8Array;
  type: string;
  finalUrl: string;
  fileName: string | null;
}

async function readBody(res: Response, onProgress: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (total > MAX_BYTES) throw new LinkError('That file is larger than 600 MB.');
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (loaded > MAX_BYTES) {
      void reader.cancel();
      throw new LinkError('That file is larger than 600 MB.');
    }
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

async function download(url: string, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<Downloaded> {
  let res: Response | null = null;
  try {
    res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, { signal, cache: 'no-store' });
  } catch (e) {
    if (isAbort(e)) throw e;
  }
  if (res?.headers.get('X-Folio-Proxy')) {
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new LinkError(body?.error ?? `The download failed (${res.status}).`);
    }
    const name = res.headers.get('X-Filename');
    const final = res.headers.get('X-Final-Url');
    return {
      bytes: await readBody(res, onProgress),
      type: res.headers.get('Content-Type') ?? '',
      finalUrl: final ? decodeURI(final) : url,
      fileName: name ? decodeURIComponent(name) : null,
    };
  }
  // No proxy here (static hosting): try the browser directly.
  try {
    res = await fetch(url, { signal, credentials: 'omit', redirect: 'follow' });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new LinkError('This site doesn’t allow downloads from other web pages. Run Folio with its own server (npm run dev or npm run preview) to add books from any link.');
  }
  if (!res.ok) throw new LinkError(`The site answered with an error (${res.status}).`);
  return { bytes: await readBody(res, onProgress), type: res.headers.get('Content-Type') ?? '', finalUrl: res.url || url, fileName: null };
}

function fileNameFor(got: Downloaded, format: DocFormat): string {
  let name = got.fileName ?? '';
  if (!name) {
    try {
      const u = new URL(got.finalUrl);
      const seg = u.pathname.split('/').filter(Boolean).pop() ?? '';
      name = decodeURIComponent(seg) || u.searchParams.get('id') || u.hostname;
    } catch {
      name = 'document';
    }
  }
  name = name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document';
  const ext = FORMATS[format].extensions[0];
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

const looksHtml = (got: Downloaded) => /html|xml/i.test(got.type) || /^\s*</.test(new TextDecoder().decode(got.bytes.subarray(0, 512)));

/**
 * Download `input` (already normalised or raw) and return the document as a File, following a
 * landing page to its PDF/EPUB when needed.
 */
export async function fetchLink(
  input: string,
  onProgress: (loaded: number, total: number) => void = () => {},
  signal?: AbortSignal,
): Promise<{ file: File; source: string; meta: LinkMeta }> {
  let url = normalizeLink(input);
  if (!url) throw new LinkError('That doesn’t look like a web link.');
  const source = url;
  const seen = new Set<string>();
  const meta: LinkMeta = {};
  for (let i = 0; i < MAX_PAGES; i++) {
    seen.add(url);
    const got = await download(url, onProgress, signal);
    if (!got.bytes.length) throw new LinkError('The link returned an empty file.');
    const probeName = got.fileName ?? new URL(got.finalUrl).pathname;
    const format = await sniffFormat(Object.assign(new Blob([got.bytes.subarray(0, 1024)]), { name: probeName }));
    if (format) {
      const file = new File([got.bytes], fileNameFor(got, format), { type: FORMATS[format].mimeTypes[0] });
      return { file, source, meta };
    }
    if (!looksHtml(got)) throw new LinkError('That link doesn’t lead to a PDF or EPUB file.');
    const html = new TextDecoder().decode(got.bytes.subarray(0, 4 * 1024 * 1024));
    const found = findDocumentLink(html, got.finalUrl);
    meta.title ??= found.meta.title;
    meta.authors ??= found.meta.authors;
    if (!found.url || seen.has(found.url)) {
      throw new LinkError(
        /captcha|cloudflare|are you a robot|access denied|pow_challenge|preparing to download|\/challenge\b/i.test(html + got.finalUrl)
          ? 'The site blocked the download with a robot check. Open the link in your browser, save the PDF, and add the file instead.'
          : found.meta.title
            ? 'This paper’s page doesn’t offer a PDF — it may be behind a paywall or need you to sign in. Try an open-access copy (e.g. on arXiv).'
            : 'That page doesn’t link to a PDF Folio can find. Try the paper’s direct PDF link.',
      );
    }
    url = found.url;
  }
  throw new LinkError('That page doesn’t link to a PDF Folio can find. Try the paper’s direct PDF link.');
}
