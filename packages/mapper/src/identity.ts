/**
 * Stable topic identities across snapshots.
 *
 * Topic keys hash their exact membership, so adding one file creates a new key. On the map that
 * would look like a topic vanishing and a new one appearing, and the AI description would be
 * thrown away for no reason. Instead, each new topic inherits the id of the previous topic it
 * overlaps most (Jaccard similarity of member files), greedily, best pairs first.
 */

export interface KnownTopic {
  id: string;
  files: string[];
}

export interface IdentityOptions {
  /** Below this overlap a topic is considered new. */
  minSimilarity?: number;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Maps each current topic key to a stable id: a matching previous id, or the key itself.
 * Deterministic: candidates are ordered by similarity, then by key and id.
 */
export function assignIdentities(
  current: { key: string; files: string[] }[],
  previousTopics: KnownTopic[],
  { minSimilarity = 0.5 }: IdentityOptions = {},
): Map<string, { id: string; similarity: number; previous: KnownTopic | null }> {
  // One entry per id: a duplicated id in the input must not be handed to two topics.
  const seenIds = new Set<string>();
  const previous = previousTopics.filter((p) => !seenIds.has(p.id) && seenIds.add(p.id));
  const previousSets = previous.map((p) => new Set(p.files));
  const currentSets = current.map((t) => ({ key: t.key, files: new Set(t.files) }));
  const owners = new Map<string, number[]>();
  previous.forEach((p, i) => {
    for (const f of p.files) {
      const list = owners.get(f);
      if (list) list.push(i);
      else owners.set(f, [i]);
    }
  });

  // Only pairs that share at least one file can match; found via the file → previous index.
  const candidates: { key: string; prev: number; similarity: number }[] = [];
  for (const t of currentSets) {
    const touched = new Set<number>();
    for (const f of t.files) for (const i of owners.get(f) ?? []) touched.add(i);
    for (const i of touched) {
      const similarity = jaccard(t.files, previousSets[i] as Set<string>);
      if (similarity >= minSimilarity) candidates.push({ key: t.key, prev: i, similarity });
    }
  }
  const idOf = (i: number) => (previous[i] as KnownTopic).id;
  candidates.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
      (idOf(a.prev) < idOf(b.prev) ? -1 : idOf(a.prev) > idOf(b.prev) ? 1 : 0),
  );

  const result = new Map<string, { id: string; similarity: number; previous: KnownTopic | null }>();
  const usedPrevious = new Set<number>();
  for (const c of candidates) {
    if (result.has(c.key) || usedPrevious.has(c.prev)) continue;
    const prev = previous[c.prev] as KnownTopic;
    result.set(c.key, { id: prev.id, similarity: c.similarity, previous: prev });
    usedPrevious.add(c.prev);
  }
  // A new topic gets its key as id, made unique against every id in use or known from before
  // (reusing an old topic's id would attach that topic's history to unrelated files).
  const taken = new Set([...seenIds, ...[...result.values()].map((r) => r.id)]);
  for (const t of current) {
    if (result.has(t.key)) continue;
    let id = t.key;
    for (let n = 2; taken.has(id); n++) id = `${t.key}-${n}`;
    taken.add(id);
    result.set(t.key, { id, similarity: 0, previous: null });
  }
  return result;
}
