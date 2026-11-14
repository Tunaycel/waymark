/**
 * Postgres `text` and `jsonb` reject two things JavaScript strings may hold: U+0000 and unpaired
 * UTF-16 surrogates (e.g. half an emoji). Repository content is untrusted, so everything derived
 * from it is cleaned before it is written; otherwise one odd comment would make a repository
 * impossible to index.
 */
export function cleanText(value: string): string {
  const wellFormed = value.isWellFormed() ? value : value.toWellFormed();
  return wellFormed.includes('\u0000') ? wellFormed.replaceAll('\u0000', '') : wellFormed;
}

/** Deep-cleans every string (keys included) in a JSON-compatible value. */
export function cleanJson<T>(value: T): T {
  if (typeof value === 'string') return cleanText(value) as T;
  if (Array.isArray(value)) return value.map(cleanJson) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[cleanText(k)] = cleanJson(v);
    return out as T;
  }
  return value;
}
