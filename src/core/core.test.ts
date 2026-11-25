import { describe, expect, it } from 'vitest';
import { fold, foldQuery, findAll, searchPages } from './text/search';
import { buildPageText, toParagraphs } from './text/structure';
import { mergeRects, pointInRects } from './geometry';
import { lookupTerm, mergeEntries } from './dictionary';
import { sectionForPage } from './pdf/indexText';
import { spreadOf, nextZoom, PT_TO_PX } from '../features/reader/store';
import type { OutlineNode } from './types';

describe('search folding', () => {
  it('lower-cases, collapses whitespace, strips diacritics and keeps an offset map', () => {
    const f = fold('  Café\n  au­lait ');
    expect(f.text).toBe('cafe aulait ');
    expect(f.map[0]).toBe(2); // "C" is at index 2 of the source
  });

  it('finds non-overlapping matches', () => {
    expect(findAll('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    expect(findAll('abc', '')).toEqual([]);
  });

  it('matches across line breaks and reports page-local indices with snippets', () => {
    const hits = searchPages(
      [
        { page: 1, text: 'Nothing here.' },
        { page: 2, text: 'The humble\nbookmark is a promise. Another bookmark.' },
      ],
      'humble  BOOKMARK',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ page: 2, indexOnPage: 0, index: 0, match: 'humble bookmark' });
    expect(searchPages([{ page: 3, text: 'bookmark bookmark' }], 'bookmark').map((h) => h.indexOnPage)).toEqual([0, 1]);
    expect(foldQuery('  Hello   World ')).toBe('hello world');
  });
});

describe('page text structure', () => {
  const item = (str: string, y: number, hasEOL = true) => ({ str, hasEOL, transform: [12, 0, 0, 12, 50, y], height: 12 });

  it('keeps lines and detects paragraph gaps', () => {
    const text = buildPageText([item('First line of a', 700), item('paragraph.', 684), item('A new paragraph', 640), item('continues.', 624)]);
    expect(text).toBe('First line of a\nparagraph.\n\nA new paragraph\ncontinues.');
  });

  it('reflows paragraphs and repairs hyphenation', () => {
    expect(toParagraphs('An inter-\nnational line\nwraps here.\n\nNext para.')).toEqual(['An international line wraps here.', 'Next para.']);
  });
});

describe('geometry', () => {
  it('merges fragments on the same line and keeps separate lines apart', () => {
    const merged = mergeRects([
      { x: 0.1, y: 0.1, w: 0.1, h: 0.02 },
      { x: 0.205, y: 0.1, w: 0.1, h: 0.02 },
      { x: 0.1, y: 0.13, w: 0.2, h: 0.02 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].x).toBeCloseTo(0.1);
    expect(merged[0].w).toBeCloseTo(0.205);
  });

  it('hit-tests normalised rects', () => {
    const rects = [{ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }];
    expect(pointInRects(0.15, 0.12, rects)).toBe(true);
    expect(pointInRects(0.5, 0.5, rects)).toBe(false);
  });
});

describe('dictionary', () => {
  it('normalises selections to lookup terms', () => {
    expect(lookupTerm('“Serendipity,”')).toBe('Serendipity');
    expect(lookupTerm("author's")).toBe('author');
    expect(lookupTerm('  well-known  ')).toBe('well-known');
  });

  it('merges API entries by part of speech and picks audio', () => {
    const e = mergeEntries(
      [
        { word: 'run', phonetics: [{ text: '/ɹʌn/', audio: '//x/run-us.mp3' }], meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'To move swiftly.', synonyms: ['sprint'] }] }] },
        { word: 'run', meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'To operate.' }] }, { partOfSpeech: 'noun', definitions: [{ definition: 'An act of running.' }] }] },
      ],
      'test',
    );
    expect(e.phonetic).toBe('/ɹʌn/');
    expect(e.audioUrl).toBe('https://x/run-us.mp3');
    expect(e.meanings.map((m) => m.partOfSpeech)).toEqual(['verb', 'noun']);
    expect(e.meanings[0].definitions).toHaveLength(2);
    expect(e.meanings[0].synonyms).toEqual(['sprint']);
  });
});

describe('reader helpers', () => {
  it('lays out spreads like a printed book', () => {
    expect(spreadOf(1, 10)).toEqual([1]);
    expect(spreadOf(2, 10)).toEqual([2, 3]);
    expect(spreadOf(3, 10)).toEqual([2, 3]);
    expect(spreadOf(10, 10)).toEqual([10]);
  });

  it('steps zoom through fixed levels', () => {
    expect(nextZoom(1 * PT_TO_PX, 1)).toBeCloseTo(1.1 * PT_TO_PX);
    expect(nextZoom(1 * PT_TO_PX, -1)).toBeCloseTo(0.9 * PT_TO_PX);
  });

  it('finds the section containing a page', () => {
    const outline: OutlineNode[] = [
      { id: 'a', title: 'One', page: 1, children: [{ id: 'a1', title: 'One.1', page: 3, children: [] }] },
      { id: 'b', title: 'Two', page: 6, children: [] },
    ];
    expect(sectionForPage(outline, 2)?.id).toBe('a');
    expect(sectionForPage(outline, 4)?.id).toBe('a1');
    expect(sectionForPage(outline, 9)?.id).toBe('b');
  });
});
