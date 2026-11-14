/**
 * Heuristic topic labels: the words that are frequent in a topic and rare in the rest of the
 * repository (TF-IDF over path segments and exported symbols). They name a topic when no AI
 * provider is configured, and they are the fallback whenever a description is unavailable.
 */

/** Words that say nothing about what code does. */
const STOPWORDS = new Set(
  `src lib libs app apps pkg packages internal cmd core common shared util utils utility utilities
  helper helpers misc index main mod module modules base default types type typings interfaces
  impl implementation test tests spec specs mock mocks fixture fixtures e2e dist build out js ts
  tsx jsx mjs cjs py go rs vue svelte astro d new get set is has to from of the and for with in on
  by a an at as or init config conf setup file files data item items value values new handler
  handlers service services manager managers class func function fn api v1 v2 v3 x y z`.split(
    /\s+/,
  ),
);

/** `createSessionToken` / `session_token` / `session-token.ts` → session, token (create kept). */
export function tokenize(text: string): string[] {
  return text
    .replace(/\.[a-z0-9]+$/i, '') // extension
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .map(singular)
    .filter((w) => w.length >= 3 && w.length <= 24 && !/^\d+$/.test(w) && !STOPWORDS.has(w));
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export interface KeywordDocument {
  /** Path segments (relative to the package), weighted above symbols. */
  paths: string[];
  symbols: string[];
}

/** Top keywords per document by TF-IDF. Deterministic: ties broken alphabetically. */
export function keywordsByTfIdf(documents: KeywordDocument[], topN = 5): string[][] {
  const counts = documents.map((doc) => {
    const tf = new Map<string, number>();
    for (const path of doc.paths) {
      // The nearest levels describe a file; deeper ancestry adds cost, not meaning.
      const segments = path.split('/').slice(-6);
      segments.forEach((segment, i) => {
        // Directories describe a group; the file name describes one member.
        const weight = i < segments.length - 1 ? 2 : 1;
        for (const word of tokenize(segment)) tf.set(word, (tf.get(word) ?? 0) + weight);
      });
    }
    for (const symbol of doc.symbols) {
      for (const word of tokenize(symbol)) tf.set(word, (tf.get(word) ?? 0) + 1);
    }
    return tf;
  });

  const df = new Map<string, number>();
  for (const tf of counts) for (const word of tf.keys()) df.set(word, (df.get(word) ?? 0) + 1);
  const n = documents.length;

  return counts.map((tf) =>
    [...tf.entries()]
      .map(([word, count]) => ({ word, score: count * Math.log(1 + n / (df.get(word) ?? 1)) }))
      .sort((a, b) => b.score - a.score || (a.word < b.word ? -1 : 1))
      .slice(0, topN)
      .map((e) => e.word),
  );
}

/** "auth", "session" → "Auth · Session". */
export function labelFrom(words: string[], fallback: string): string {
  const picked = words.slice(0, 2);
  if (picked.length === 0) return fallback;
  return picked.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' · ');
}
