import { describe, expect, it } from 'vitest';
import { answerAsNote, describeAnswer } from './notes';
import type { AnswerCitation } from './api';

const cite = (start: number, end: number, page: number): AnswerCitation => ({ id: start, source: 1, chunkId: 'c', page, locations: [], quote: `q${page}`, start, end, headingPath: [] });
const ref = (p: number) => `p. ${p}`;

describe('answerAsNote', () => {
  it('puts a page reference where each chip was, merging pages cited at one point', () => {
    const text = 'Scaling keeps gradients usable. Heads run in parallel.';
    const first = 'Scaling keeps gradients usable. '.length;
    expect(answerAsNote(text, [cite(0, first, 4), cite(first, text.length, 5), cite(first, text.length, 3), cite(first, text.length, 5)], ref)).toBe(
      'Scaling keeps gradients usable. (p. 4) Heads run in parallel. (p. 3, p. 5)',
    );
  });

  it('writes Markdown and math as plain text but keeps list lines', () => {
    const text = '## Why\n**Scaling** keeps *softmax* stable when $d_k$ is large:\n\n\n- see [the paper](https://x.y)\n- costs $5 and $10';
    expect(answerAsNote(text, [], ref)).toBe('Why\nScaling keeps softmax stable when d_k is large:\n\n- see the paper\n- costs $5 and $10');
  });
});

describe('describeAnswer', () => {
  it('titles a selection mode by what it did and quotes the selection', () => {
    const d = describeAnswer({ mode: 'explain', question: '', selection: 'Attention is the scarce resource of our age.', selectionPage: 2, text: 'It means focus is limited.', citations: [] }, ref);
    expect(d).toEqual({ title: 'Explanation: “Attention is the scarce resource of our age.”', body: '“Attention is the scarce resource of our age.”\n\nIt means focus is limited.', page: 2 });
  });

  it('titles a chat answer by its question and files it on the first cited page', () => {
    const d = describeAnswer({ mode: 'chat', question: 'Why  scale\nthe dot products?', text: 'To keep gradients usable.', citations: [cite(0, 25, 4), cite(0, 25, 2)] }, ref);
    expect(d).toEqual({ title: 'Why scale the dot products?', body: 'To keep gradients usable. (p. 2, p. 4)', page: 4 });
  });
});
