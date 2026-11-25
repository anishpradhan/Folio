// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zipSync } from 'fflate';

// Typed arrays from this realm (TextEncoder output under jsdom comes from another realm, which fflate
// would mistake for a folder).
const strToU8 = (s: string) => Uint8Array.from(Buffer.from(s, 'utf8'));
import { parseEpub, resolvePath, EpubError } from './epub';
import { sectionElement } from './book';
import { htmlText, indexHtml, segmentsFor, foldedOffsetOf, wrapSegments } from '../text/domText';
import { findAll, foldQuery, searchPages } from '../text/search';

const fixture = (name: string) => new Uint8Array(readFileSync(resolve(process.cwd(), 'tests/fixtures', name)));

describe('EPUB package', () => {
  const pkg = parseEpub(fixture('lantern-keeper.epub'));

  it('reads metadata, spine and cover', () => {
    expect(pkg.metadata.title).toBe('The Lantern Keeper');
    expect(pkg.metadata.creator).toBe('Mara Ellison');
    expect(pkg.spine).toEqual(['OEBPS/text/cover.xhtml', 'OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml', 'OEBPS/text/ch3.xhtml', 'OEBPS/text/ch4.xhtml']);
    expect(pkg.coverPath).toBe('OEBPS/images/cover.svg');
  });

  it('prefers the EPUB 3 nav document, nested, with fragments mapped to sections', () => {
    expect(pkg.toc.map((t) => t.title)).toEqual(['Chapter One: The Harbour', 'Chapter Two: Weather', 'Chapter Three: Letters', 'Chapter Four: The Lighthouse']);
    expect(pkg.toc[0].page).toBe(2);
    expect(pkg.toc[1].children.map((c) => [c.title, c.page, c.anchor])).toEqual([
      ['The First Storm', 3, 's2a'],
      ['After the Storm', 3, 's2b'],
    ]);
  });

  it('falls back to the NCX and tolerates sloppy EPUB 2 files', () => {
    const old = parseEpub(fixture('old-almanac.epub'));
    expect(old.metadata.title).toBe('Old Almanac');
    expect(old.spine).toHaveLength(2); // Part1.html resolved case-insensitively
    expect(old.toc.map((t) => [t.title, t.page])).toEqual([
      ['Spring', 1],
      ['Summer', 2],
    ]);
    expect(htmlText(sectionElement(old, 1, () => null))).toContain('Plant the peas');
  });

  it('rejects DRM-protected books but allows font obfuscation', () => {
    const base = () => ({
      'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>'),
      'c.opf': strToU8('<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>'),
      'a.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>x</p></body></html>'),
    });
    const enc = (uri: string) => strToU8(`<encryption><EncryptedData><CipherData><CipherReference URI="${uri}"/></CipherData></EncryptedData></encryption>`);
    expect(() => parseEpub(zipSync({ ...base(), 'META-INF/encryption.xml': enc('a.xhtml') }))).toThrow(/DRM/);
    expect(() => parseEpub(zipSync({ ...base(), 'META-INF/encryption.xml': enc('fonts/x.otf') }))).not.toThrow();
    expect(() => parseEpub(new Uint8Array([1, 2, 3]))).toThrow(EpubError);
  });

  it('resolves relative paths', () => {
    expect(resolvePath('OEBPS/text/ch3.xhtml', '../images/a%20b.png#x')).toEqual({ path: 'OEBPS/images/a b.png', fragment: 'x' });
    expect(resolvePath('OEBPS/text/ch3.xhtml', 'ch1.xhtml')).toEqual({ path: 'OEBPS/text/ch1.xhtml', fragment: '' });
  });
});

describe('section sanitising', () => {
  const pkg = parseEpub(fixture('lantern-keeper.epub'));
  const el = sectionElement(pkg, 4, (p) => `blob:${p}`);
  const html = el.innerHTML;

  it('drops scripts, frames, styles, event handlers and javascript: links', () => {
    expect(html).not.toMatch(/<script|<iframe|<style|<link|onclick|javascript:|__pwned/i);
  });

  it('keeps structure, images, internal and external links', () => {
    expect(el.querySelector('h1')?.textContent).toBe('Chapter Three: Letters');
    expect(el.querySelector('img')?.getAttribute('src')).toBe('blob:OEBPS/images/figure.svg');
    const internal = el.querySelector('a[data-section]')!;
    expect(internal.getAttribute('data-section')).toBe('2');
    expect(internal.getAttribute('data-anchor')).toBe('start');
    const external = el.querySelector('a[target="_blank"]')!;
    expect(external.getAttribute('href')).toBe('https://example.org/tides');
    expect(external.getAttribute('rel')).toContain('noopener');
  });

  it('turns SVG cover pages into images and prefixes ids', () => {
    expect(sectionElement(pkg, 1, (p) => `blob:${p}`).querySelector('img')?.getAttribute('src')).toBe('blob:OEBPS/images/cover.svg');
    expect(sectionElement(pkg, 2, () => null).querySelector('h1')?.id).toBe('ep-start');
  });
});

describe('DOM text index', () => {
  const pkg = parseEpub(fixture('lantern-keeper.epub'));

  it('stored text and DOM index agree, so search hits can be located in the page', () => {
    const el = sectionElement(pkg, 3, () => null);
    const stored = htmlText(el);
    const hits = searchPages([{ page: 3, text: stored }], 'lantern');
    expect(hits).toHaveLength(2);
    const idx = indexHtml(el);
    expect(findAll(idx.folded.text, foldQuery('lantern'))).toHaveLength(2);
    // Block boundaries separate words: headings don't run into paragraphs.
    expect(stored).toMatch(/Weather\n+The First Storm/);
  });

  it('wraps matches across element boundaries and maps selections back to offsets', () => {
    const el = sectionElement(pkg, 2, () => null);
    document.body.append(el);
    const idx = indexHtml(el);
    const q = foldQuery('ledger: All well');
    const [m] = findAll(idx.folded.text, q);
    expect(m).toBeTruthy();
    const segs = segmentsFor(idx, m.start, m.end);
    expect(segs.length).toBeGreaterThan(1); // crosses into <em>
    const em = el.querySelector('em')!;
    expect(foldedOffsetOf(idx, em.firstChild!, 0)).toBe(idx.folded.text.indexOf('all well'));
    wrapSegments([{ segments: segs, make: () => Object.assign(document.createElement('mark'), { className: 'hit' }) }]);
    expect(Array.from(el.querySelectorAll('mark.hit')).map((x) => x.textContent).join('')).toBe('ledger: All well');
    expect(htmlText(el)).toBe(htmlText(sectionElement(pkg, 2, () => null))); // marks don't change the text
  });
});
