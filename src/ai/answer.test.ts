import { describe, expect, it } from 'vitest';
import { chipOffset, plainMath, renderInline, segmentAnswer, type Block } from './answer';
import { readEvents, type AnswerCitation, type AnswerEvent } from './api';

const cite = (start: number, end: number, page = 4, quote = `q${start}`): AnswerCitation => ({ id: start, source: 1, chunkId: 'c', page, locations: [], quote, start, end, headingPath: [] });
const flat = (b: Block[]) => b.map((x) => `${x.kind}:` + x.inlines.map((i) => (i.kind === 'text' ? i.text : `[${i.citations.map((c) => c.page).join(',')}]`)).join(''));

describe('segmentAnswer', () => {
  it('places a chip where the cited span ends, before trailing whitespace', () => {
    const text = 'Scaling keeps gradients usable. \n\nHeads run in parallel.';
    expect(chipOffset(text, { start: 0, end: 33 })).toBe(31);
    expect(flat(segmentAnswer(text, [cite(0, 33), cite(33, text.length, 5)]))).toEqual(['p:Scaling keeps gradients usable.[4]', 'p:Heads run in parallel.[5]']);
  });

  it('keeps several chips at one point, dropping exact duplicates', () => {
    const text = 'Both ideas appear.';
    const out = segmentAnswer(text, [cite(0, 18, 4, 'a'), cite(0, 18, 6, 'b'), cite(0, 18, 4, 'a')]);
    expect(flat(out)).toEqual(['p:Both ideas appear.[4,6]']);
  });

  it('turns list lines into list blocks and keeps chips inside the right item', () => {
    const text = 'Two reasons:\n- It is faster.\n- It is simpler.';
    const first = text.indexOf('It is faster.') + 'It is faster.'.length;
    const out = segmentAnswer(text, [cite(13, first, 2), cite(first + 1, text.length, 3)]);
    expect(flat(out)).toEqual(['p:Two reasons:', 'ul:It is faster.[2]', 'ul:It is simpler.[3]']);
  });

  it('joins soft-wrapped lines into one paragraph and recognises numbered lists and headings', () => {
    const out = segmentAnswer('## Summary\nOne line\ncontinues here.\n1. First\n2) Second', []);
    expect(flat(out)).toEqual(['h:Summary', 'p:One line continues here.', 'ol:First', 'ol:Second']);
  });

  it('shows chips whose offsets fall outside the text instead of dropping them', () => {
    expect(flat(segmentAnswer('', [cite(0, 0, 7)]))).toEqual(['p:[7]']);
    expect(flat(segmentAnswer('Short.', [cite(0, 999, 8)]))).toEqual(['p:Short.[8]']);
  });
});

describe('inline math', () => {
  const texts = (nodes: ReturnType<typeof renderInline>) =>
    nodes.map((n) => (typeof n === 'string' ? n : `<${(n as { type: string }).type}>${(n as { props: { children: string } }).props.children}`));

  it('shows $…$ as italic text without the dollars, and leaves prices alone', () => {
    expect(texts(renderInline('when $d_k$ is large'))).toEqual(['when ', '<em>d_k', ' is large']);
    expect(texts(renderInline('scale by $\\frac{1}{\\sqrt{d_k}}$'))).toEqual(['scale by ', '<em>1/√d_k']);
    expect(texts(renderInline('costs $5 and $10 a month'))).toEqual(['costs $5 and $10 a month']);
    expect(plainMath('\\alpha \\cdot \\text{softmax}(x)')).toBe('α · softmax(x)');
  });
});

describe('readEvents', () => {
  it('parses frames split across network chunks', async () => {
    const frames = 'event: delta\ndata: {"text":"Hel"}\n\nevent: delta\ndata: {"text":"lo"}\n\nevent: done\ndata: {"messageId":"m","status":"complete","stopReason":"end_turn","model":"x"}\n\n';
    const enc = new TextEncoder().encode(frames);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < enc.length; i += 7) c.enqueue(enc.slice(i, i + 7)); // split mid-frame and mid-character
        c.close();
      },
    });
    const got: AnswerEvent[] = [];
    await readEvents(body, (e) => got.push(e));
    expect(got.map((e) => e.event)).toEqual(['delta', 'delta', 'done']);
    expect(got.slice(0, 2).map((e) => (e.data as { text: string }).text).join('')).toBe('Hello');
  });
});
