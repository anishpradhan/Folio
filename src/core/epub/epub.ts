import { unzipSync, strFromU8 } from 'fflate';
import type { OutlineNode } from '../types';
import { uid } from '../../lib/util';

/**
 * EPUB 2/3 package reading: container → OPF (metadata, manifest, spine) → table of contents
 * (EPUB 3 nav document, falling back to the EPUB 2 NCX). Pure parsing — rendering and sanitising
 * live in sanitize.ts and book.ts.
 */

export class EpubError extends Error {
  constructor(
    public kind: 'corrupt' | 'drm' | 'empty',
    message: string,
  ) {
    super(message);
  }
}

export interface ManifestItem {
  id: string;
  /** Full path inside the zip. */
  path: string;
  mediaType: string;
  properties: string[];
}

export interface EpubPackage {
  files: Record<string, Uint8Array>;
  opfPath: string;
  metadata: { title: string; creator: string; subject: string; description: string; date: string; language: string; publisher: string };
  manifest: Map<string, ManifestItem>;
  /** Reading order: zip paths of the content documents (linear items first, in order). */
  spine: string[];
  toc: OutlineNode[];
  coverPath: string | null;
}

const OPS_NS = 'http://www.idpf.org/2007/ops';

/** Resolve `href` (possibly with ../ and %20) against the directory of `base`; drops any #fragment. */
export function resolvePath(base: string, href: string): { path: string; fragment: string } {
  const [raw, fragment = ''] = href.split('#');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  if (/^[a-z]+:/i.test(decoded)) return { path: decoded, fragment };
  const parts = decoded.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const seg of decoded.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return { path: parts.join('/'), fragment };
}

export function parseXml(text: string, type: DOMParserSupportedType = 'application/xhtml+xml'): Document {
  const doc = new DOMParser().parseFromString(text, type);
  if (doc.getElementsByTagName('parsererror').length) {
    // Many real-world EPUBs contain sloppy XHTML; the HTML parser is forgiving.
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

const byTag = (root: Document | Element, name: string) => Array.from(root.getElementsByTagNameNS('*', name));
const firstText = (root: Document | Element, name: string) => byTag(root, name)[0]?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

export function readFile(files: Record<string, Uint8Array>, path: string): Uint8Array | undefined {
  if (files[path]) return files[path];
  // Case-insensitive fallback (zips made on Windows/macOS sometimes disagree with the OPF).
  const lower = path.toLowerCase();
  const key = Object.keys(files).find((k) => k.toLowerCase() === lower);
  return key ? files[key] : undefined;
}

export function parseEpub(bytes: Uint8Array): EpubPackage {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new EpubError('corrupt', "This EPUB couldn't be opened — the file may be damaged.");
  }

  const container = readFile(files, 'META-INF/container.xml');
  if (!container) throw new EpubError('corrupt', 'This EPUB is missing its container file.');
  const rootfile = byTag(parseXml(strFromU8(container), 'application/xml'), 'rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path');
  const opfBytes = opfPath ? readFile(files, opfPath) : undefined;
  if (!opfPath || !opfBytes) throw new EpubError('corrupt', 'This EPUB is missing its package document.');

  // DRM: encryption.xml listing content documents (font obfuscation alone is fine).
  const enc = readFile(files, 'META-INF/encryption.xml');
  if (enc) {
    const refs = byTag(parseXml(strFromU8(enc), 'application/xml'), 'CipherReference').map((c) => c.getAttribute('URI') ?? '');
    if (refs.some((u) => /\.(x?html?|xml|ncx)$/i.test(u))) throw new EpubError('drm', 'This EPUB is protected by DRM, so it can’t be opened here.');
  }

  const opf = parseXml(strFromU8(opfBytes), 'application/xml');
  const manifest = new Map<string, ManifestItem>();
  for (const item of byTag(opf, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      path: resolvePath(opfPath, href).path,
      mediaType: item.getAttribute('media-type') ?? '',
      properties: (item.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
    });
  }

  const spineEl = byTag(opf, 'spine')[0];
  const itemrefs = spineEl ? byTag(spineEl, 'itemref') : [];
  const linear = itemrefs.filter((r) => r.getAttribute('linear') !== 'no');
  const nonLinear = itemrefs.filter((r) => r.getAttribute('linear') === 'no');
  const spine = [...linear, ...nonLinear]
    .map((r) => manifest.get(r.getAttribute('idref') ?? ''))
    .filter((m): m is ManifestItem => !!m && /html|xml/.test(m.mediaType) && !!readFile(files, m.path))
    .map((m) => m.path);
  if (!spine.length) throw new EpubError('empty', 'This EPUB has no readable chapters.');

  const meta = byTag(opf, 'metadata')[0] ?? opf.documentElement;
  const metadata = {
    title: firstText(meta, 'title'),
    creator: byTag(meta, 'creator')
      .map((c) => c.textContent?.trim())
      .filter(Boolean)
      .join(', '),
    subject: byTag(meta, 'subject')
      .map((c) => c.textContent?.trim())
      .filter(Boolean)
      .join(', '),
    description: firstText(meta, 'description').replace(/<[^>]+>/g, ''),
    date: firstText(meta, 'date'),
    language: firstText(meta, 'language'),
    publisher: firstText(meta, 'publisher'),
  };

  // Cover: EPUB 3 "cover-image" property, else EPUB 2 <meta name="cover" content="id">.
  let coverPath: string | null = [...manifest.values()].find((m) => m.properties.includes('cover-image'))?.path ?? null;
  if (!coverPath) {
    const id = byTag(meta, 'meta')
      .find((m) => m.getAttribute('name') === 'cover')
      ?.getAttribute('content');
    const item = id ? manifest.get(id) : undefined;
    if (item && item.mediaType.startsWith('image/')) coverPath = item.path;
  }

  const pageOf = (path: string) => {
    const i = spine.indexOf(path);
    if (i >= 0) return i + 1;
    const lower = path.toLowerCase();
    const j = spine.findIndex((p) => p.toLowerCase() === lower);
    return j >= 0 ? j + 1 : null;
  };

  // Table of contents
  let toc: OutlineNode[] = [];
  const navItem = [...manifest.values()].find((m) => m.properties.includes('nav'));
  const navBytes = navItem ? readFile(files, navItem.path) : undefined;
  if (navItem && navBytes) {
    const navDoc = parseXml(strFromU8(navBytes));
    const navs = byTag(navDoc, 'nav');
    const tocNav = navs.find((n) => (n.getAttributeNS(OPS_NS, 'type') ?? n.getAttribute('epub:type') ?? '').split(/\s+/).includes('toc')) ?? navs[0];
    const walkOl = (ol: Element | undefined): OutlineNode[] =>
      ol
        ? Array.from(ol.children)
            .filter((li) => li.localName === 'li')
            .map((li) => {
              const a = Array.from(li.children).find((c) => c.localName === 'a' || c.localName === 'span');
              const href = a?.localName === 'a' ? a.getAttribute('href') : null;
              const target = href ? resolvePath(navItem.path, href) : null;
              return {
                id: uid(),
                title: a?.textContent?.replace(/\s+/g, ' ').trim() || 'Untitled',
                page: target ? pageOf(target.path) : null,
                anchor: target?.fragment || undefined,
                children: walkOl(Array.from(li.children).find((c) => c.localName === 'ol')),
              };
            })
        : [];
    if (tocNav) toc = walkOl(Array.from(tocNav.children).find((c) => c.localName === 'ol') ?? byTag(tocNav, 'ol')[0]);
  }
  if (!toc.length) {
    const ncxId = spineEl?.getAttribute('toc');
    const ncxItem = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => m.mediaType === 'application/x-dtbncx+xml');
    const ncxBytes = ncxItem ? readFile(files, ncxItem.path) : undefined;
    if (ncxItem && ncxBytes) {
      const ncx = parseXml(strFromU8(ncxBytes), 'application/xml');
      const walk = (parent: Element): OutlineNode[] =>
        Array.from(parent.children)
          .filter((c) => c.localName === 'navPoint')
          .map((np) => {
            const src = Array.from(np.children).find((c) => c.localName === 'content')?.getAttribute('src');
            const target = src ? resolvePath(ncxItem.path, src) : null;
            const label = Array.from(np.children).find((c) => c.localName === 'navLabel');
            return {
              id: uid(),
              title: label?.textContent?.replace(/\s+/g, ' ').trim() || 'Untitled',
              page: target ? pageOf(target.path) : null,
              anchor: target?.fragment || undefined,
              children: walk(np),
            };
          });
      const navMap = byTag(ncx, 'navMap')[0];
      if (navMap) toc = walk(navMap);
    }
  }

  return { files, opfPath, metadata, manifest, spine, toc, coverPath };
}

export function mediaTypeOf(pkg: EpubPackage, path: string): string {
  for (const m of pkg.manifest.values()) if (m.path === path) return m.mediaType;
  const ext = path.split('.').pop()?.toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
}
