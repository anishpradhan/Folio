import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256 } from './sha256';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('pure-JS sha256 fallback', () => {
  it('matches known vectors and node:crypto across padding boundaries', () => {
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256(new Uint8Array(0)))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_003]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
      expect(hex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });
});
