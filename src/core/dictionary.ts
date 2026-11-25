import type { DictionaryEntry, DictionaryMeaning } from './types';

/**
 * Dictionary lookup behind a provider interface. The default provider is the free, keyless
 * Free Dictionary API (https://dictionaryapi.dev, Wiktionary-derived). A contextual AI explainer
 * can later be added as a second provider (the AI backend's explain mode, src/ai/api.ts, is one).
 */
export interface DictionaryProvider {
  name: string;
  lookup(word: string, signal?: AbortSignal): Promise<DictionaryEntry | null>;
}

export class DictionaryError extends Error {
  constructor(
    public kind: 'offline' | 'network' | 'rate-limited',
    message: string,
  ) {
    super(message);
  }
}

interface ApiPhonetic {
  text?: string;
  audio?: string;
}
interface ApiEntry {
  word: string;
  phonetic?: string;
  phonetics?: ApiPhonetic[];
  meanings?: { partOfSpeech: string; definitions: { definition: string; example?: string; synonyms?: string[] }[]; synonyms?: string[] }[];
  sourceUrls?: string[];
}

export const freeDictionary: DictionaryProvider = {
  name: 'Free Dictionary API · Wiktionary',
  async lookup(word, signal) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
      throw new DictionaryError('offline', 'You appear to be offline — the dictionary needs a connection.');
    let res: Response;
    try {
      res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new DictionaryError('network', "Couldn't reach the dictionary. Check your connection and try again.");
    }
    if (res.status === 404) return null;
    if (res.status === 429) throw new DictionaryError('rate-limited', 'The dictionary is busy. Try again in a moment.');
    if (!res.ok) throw new DictionaryError('network', `The dictionary returned an error (${res.status}).`);
    const data = (await res.json()) as ApiEntry[];
    if (!Array.isArray(data) || !data.length) return null;
    return mergeEntries(data, this.name);
  },
};

/** The API returns one entry per etymology; merge them into a single entry grouped by part of speech. */
export function mergeEntries(entries: ApiEntry[], sourceName: string): DictionaryEntry {
  const first = entries[0];
  const phonetics = entries.flatMap((e) => e.phonetics ?? []);
  const phonetic = first.phonetic || entries.find((e) => e.phonetic)?.phonetic || phonetics.find((p) => p.text)?.text || null;
  const audio = phonetics.find((p) => p.audio && /-us\.mp3$/.test(p.audio))?.audio || phonetics.find((p) => p.audio)?.audio || null;
  const byPos = new Map<string, DictionaryMeaning>();
  for (const e of entries)
    for (const m of e.meanings ?? []) {
      const cur = byPos.get(m.partOfSpeech) ?? { partOfSpeech: m.partOfSpeech, definitions: [], synonyms: [] };
      for (const d of m.definitions ?? []) {
        if (cur.definitions.length < 6) cur.definitions.push({ definition: d.definition, example: d.example });
        for (const s of d.synonyms ?? []) if (!cur.synonyms.includes(s)) cur.synonyms.push(s);
      }
      for (const s of m.synonyms ?? []) if (!cur.synonyms.includes(s)) cur.synonyms.push(s);
      byPos.set(m.partOfSpeech, cur);
    }
  return {
    word: first.word,
    phonetic,
    audioUrl: audio ? (audio.startsWith('//') ? `https:${audio}` : audio) : null,
    meanings: [...byPos.values()].map((m) => ({ ...m, synonyms: m.synonyms.slice(0, 10) })),
    sourceName,
    sourceUrl: first.sourceUrls?.[0] ?? null,
  };
}

const cache = new Map<string, DictionaryEntry | null>();

/** Normalise a selection to a lookup term: trims punctuation, keeps inner hyphens/apostrophes. */
export function lookupTerm(selection: string): string {
  return selection
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/'s$/i, '');
}

export async function lookupWord(raw: string, signal?: AbortSignal, provider: DictionaryProvider = freeDictionary): Promise<DictionaryEntry | null> {
  const term = lookupTerm(raw);
  if (!term) return null;
  const key = term.toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  let entry = await provider.lookup(key, signal);
  // Simple inflection fallback: "running" → "run", "studies" → "study", "walked" → "walk".
  if (!entry && !key.includes(' ')) {
    for (const cand of stems(key)) {
      entry = await provider.lookup(cand, signal);
      if (entry) break;
    }
  }
  cache.set(key, entry);
  return entry;
}

function stems(w: string): string[] {
  const c: string[] = [];
  if (w.endsWith('ies')) c.push(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) c.push(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) c.push(w.slice(0, -1));
  if (w.endsWith('ing')) c.push(w.slice(0, -3), w.slice(0, -3) + 'e');
  if (w.endsWith('ed')) c.push(w.slice(0, -2), w.slice(0, -1));
  if (w.endsWith('ly')) c.push(w.slice(0, -2));
  return [...new Set(c)].filter((x) => x.length > 2).slice(0, 3);
}
