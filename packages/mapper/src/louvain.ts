/**
 * Louvain community detection (Blondel et al., 2008) on an undirected weighted graph.
 *
 * Files that import each other a lot end up in the same community, which is what a "topic" is:
 * `api/auth.ts`, `lib/session.ts`, and `middleware/guard.ts` group together even though they live
 * in different directories.
 *
 * Deterministic by construction: nodes are visited in index order, ties go to the lowest community
 * id, and there is no randomness, so the same graph always yields the same topics (stable maps,
 * stable cache keys for AI descriptions).
 */

export interface LouvainOptions {
  /** > 1 favours more, smaller communities; < 1 fewer, larger ones. */
  resolution?: number;
  /** Bounds on work, so adversarial graphs can't run long. */
  maxLevels?: number;
  maxSweeps?: number;
}

interface Level {
  n: number;
  neighbors: Map<number, number>[];
  selfLoops: number[];
  degree: number[];
}

/** Returns the community index (0-based, dense) of each node. */
export function louvain(
  n: number,
  edges: Iterable<readonly [number, number, number]>,
  { resolution = 1, maxLevels = 12, maxSweeps = 32 }: LouvainOptions = {},
): number[] {
  let level = buildLevel(n, edges);
  // membership[node] = community of that original node at the current level.
  let membership = Array.from({ length: n }, (_, i) => i);
  const total = level.degree.reduce((a, b) => a + b, 0);
  if (n === 0 || total === 0) return membership;

  for (let depth = 0; depth < maxLevels; depth++) {
    const communities = moveNodes(level, total, resolution, maxSweeps);
    const { dense, count } = densify(communities);
    membership = membership.map((c) => dense[c] as number);
    if (count === level.n) break; // no node moved: converged
    level = aggregate(level, dense, count);
  }
  return membership;
}

function buildLevel(n: number, edges: Iterable<readonly [number, number, number]>): Level {
  const neighbors = Array.from({ length: n }, () => new Map<number, number>());
  const selfLoops = new Array<number>(n).fill(0);
  for (const [a, b, w] of edges) {
    if (!(w > 0) || a < 0 || b < 0 || a >= n || b >= n) continue;
    if (a === b) {
      selfLoops[a] = (selfLoops[a] as number) + w;
      continue;
    }
    const na = neighbors[a] as Map<number, number>;
    const nb = neighbors[b] as Map<number, number>;
    na.set(b, (na.get(b) ?? 0) + w);
    nb.set(a, (nb.get(a) ?? 0) + w);
  }
  return withDegrees({ n, neighbors, selfLoops, degree: [] });
}

function withDegrees(level: Level): Level {
  level.degree = level.neighbors.map((m, i) => {
    let sum = 2 * (level.selfLoops[i] as number);
    for (const w of m.values()) sum += w;
    return sum;
  });
  return level;
}

/** One Louvain phase: greedily move nodes to the neighbouring community with the best gain. */
function moveNodes(level: Level, total: number, resolution: number, maxSweeps: number): number[] {
  const community = Array.from({ length: level.n }, (_, i) => i);
  const tot = [...level.degree];
  const linkTo = new Map<number, number>();

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let moved = false;
    for (let i = 0; i < level.n; i++) {
      const own = community[i] as number;
      const k = level.degree[i] as number;
      linkTo.clear();
      for (const [j, w] of level.neighbors[i] as Map<number, number>) {
        const c = community[j] as number;
        linkTo.set(c, (linkTo.get(c) ?? 0) + w);
      }
      tot[own] = (tot[own] as number) - k;

      const gain = (c: number) =>
        (linkTo.get(c) ?? 0) - (resolution * (tot[c] as number) * k) / total;
      let best = own;
      let bestGain = gain(own);
      for (const c of linkTo.keys()) {
        const g = gain(c);
        if (g > bestGain + 1e-12 || (Math.abs(g - bestGain) <= 1e-12 && c < best)) {
          best = c;
          bestGain = g;
        }
      }
      tot[best] = (tot[best] as number) + k;
      if (best !== own) {
        community[i] = best;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return community;
}

/** Renumbers communities 0..count-1 in order of first appearance. */
function densify(communities: number[]): { dense: number[]; count: number } {
  const map = new Map<number, number>();
  const dense = communities.map((c) => {
    let d = map.get(c);
    if (d === undefined) {
      d = map.size;
      map.set(c, d);
    }
    return d;
  });
  return { dense, count: map.size };
}

/** Collapses each community into one node; internal weight becomes a self-loop. */
function aggregate(level: Level, dense: number[], count: number): Level {
  const neighbors = Array.from({ length: count }, () => new Map<number, number>());
  const selfLoops = new Array<number>(count).fill(0);
  for (let i = 0; i < level.n; i++) {
    const ci = dense[i] as number;
    selfLoops[ci] = (selfLoops[ci] as number) + (level.selfLoops[i] as number);
    for (const [j, w] of level.neighbors[i] as Map<number, number>) {
      const cj = dense[j] as number;
      if (ci === cj) {
        // Each internal edge is seen from both ends; count it once.
        if (i < j) selfLoops[ci] = (selfLoops[ci] as number) + w;
      } else {
        const m = neighbors[ci] as Map<number, number>;
        m.set(cj, (m.get(cj) ?? 0) + w);
      }
    }
  }
  return withDegrees({ n: count, neighbors, selfLoops, degree: [] });
}

/** Newman modularity of a partition: used by tests to check quality, not by the algorithm. */
export function modularity(
  n: number,
  edges: readonly (readonly [number, number, number])[],
  membership: number[],
): number {
  const level = buildLevel(n, edges);
  const total = level.degree.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const internal = new Map<number, number>();
  const degreeSum = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const c = membership[i] as number;
    degreeSum.set(c, (degreeSum.get(c) ?? 0) + (level.degree[i] as number));
    internal.set(c, (internal.get(c) ?? 0) + 2 * (level.selfLoops[i] as number));
    for (const [j, w] of level.neighbors[i] as Map<number, number>) {
      if (membership[j] === c) internal.set(c, (internal.get(c) ?? 0) + w);
    }
  }
  let q = 0;
  for (const [c, inside] of internal) {
    const d = degreeSum.get(c) ?? 0;
    q += inside / total - (d / total) ** 2;
  }
  return q;
}
