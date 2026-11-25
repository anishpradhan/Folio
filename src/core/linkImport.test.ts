import { describe, expect, it } from 'vitest';
import { findDocumentLink, normalizeLink } from './linkImport';

describe('normalizeLink', () => {
  it('accepts URLs, bare hosts, DOIs and arXiv ids', () => {
    expect(normalizeLink('https://example.com/a.pdf')).toBe('https://example.com/a.pdf');
    expect(normalizeLink('  example.com/paper.pdf ')).toBe('https://example.com/paper.pdf');
    expect(normalizeLink('10.18653/v1/N19-1423')).toBe('https://doi.org/10.18653/v1/N19-1423');
    expect(normalizeLink('doi:10.1145/3442188.3445922')).toBe('https://doi.org/10.1145/3442188.3445922');
    expect(normalizeLink('https://dx.doi.org/10.1000/xyz')).toBe('https://doi.org/10.1000/xyz');
    expect(normalizeLink('1706.03762')).toBe('https://arxiv.org/abs/1706.03762');
    expect(normalizeLink('arXiv:2301.00001v2')).toBe('https://arxiv.org/abs/2301.00001v2');
    expect(normalizeLink('hep-th/9901001')).toBe('https://arxiv.org/abs/hep-th/9901001');
  });

  it('rejects things that are not web links', () => {
    expect(normalizeLink('')).toBeNull();
    expect(normalizeLink('hello world')).toBeNull();
    expect(normalizeLink('notalink')).toBeNull();
    expect(normalizeLink('file:///etc/passwd')).toBeNull();
    expect(normalizeLink('javascript:alert(1)')).toBeNull();
  });

  it('rewrites share pages to their downloads', () => {
    expect(normalizeLink('https://openreview.net/forum?id=abc123')).toBe('https://openreview.net/pdf?id=abc123');
    expect(normalizeLink('https://drive.google.com/file/d/1AbC-d_E/view?usp=sharing')).toBe('https://drive.google.com/uc?export=download&id=1AbC-d_E');
    expect(normalizeLink('https://www.dropbox.com/s/xyz/paper.pdf?dl=0')).toBe('https://www.dropbox.com/s/xyz/paper.pdf?dl=1');
    expect(normalizeLink('https://github.com/o/r/blob/main/paper.pdf')).toBe('https://github.com/o/r/blob/main/paper.pdf?raw=1');
  });
});

describe('findDocumentLink', () => {
  const base = 'https://journal.example/article/42';

  it('prefers citation_pdf_url and reads paper metadata', () => {
    const html = `<html><head>
      <meta name="citation_title" content="Attention Is All You Need">
      <meta name="citation_author" content="Vaswani, Ashish"><meta name="citation_author" content="Shazeer, Noam">
      <meta name="citation_pdf_url" content="/article/42/pdf?download=1&amp;v=2">
      </head><body><a href="/other.pdf">Supplement PDF</a></body></html>`;
    const r = findDocumentLink(html, base);
    expect(r.url).toBe('https://journal.example/article/42/pdf?download=1&v=2');
    expect(r.meta).toEqual({ title: 'Attention Is All You Need', authors: ['Vaswani, Ashish', 'Shazeer, Noam'] });
  });

  it('falls back to alternate links, meta refresh, then a PDF anchor', () => {
    expect(findDocumentLink('<link rel="alternate" type="application/pdf" href="full.pdf">', base).url).toBe('https://journal.example/article/full.pdf');
    expect(findDocumentLink(`<meta http-equiv="refresh" content="0; url='https://x.example/next'">`, base).url).toBe('https://x.example/next');
    expect(findDocumentLink('<a href="/a.pdf">Figure</a> <a href="/b.pdf"><span>Download PDF</span></a>', base).url).toBe('https://journal.example/b.pdf');
    expect(findDocumentLink('<a href="/only.pdf">paper</a>', base).url).toBe('https://journal.example/only.pdf');
    expect(findDocumentLink('<p>No document here</p><a href="javascript:void 0">PDF</a>', base).url).toBeNull();
  });
});
