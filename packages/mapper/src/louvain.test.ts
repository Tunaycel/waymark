import { describe, expect, it } from 'vitest';
import { louvain, modularity } from './louvain.ts';

type Edge = [number, number, number];

/** k cliques of size s, joined in a ring by single weak edges. */
function ringOfCliques(k: number, s: number): Edge[] {
  const edges: Edge[] = [];
  for (let c = 0; c < k; c++) {
    for (let a = 0; a < s; a++) {
      for (let b = a + 1; b < s; b++) edges.push([c * s + a, c * s + b, 1]);
    }
    edges.push([c * s, ((c + 1) % k) * s + 1, 1]);
  }
  return edges;
}

describe('louvain', () => {
  it('recovers planted communities (ring of cliques)', () => {
    const edges = ringOfCliques(6, 5);
    const membership = louvain(30, edges);
    for (let c = 0; c < 6; c++) {
      const group = membership.slice(c * 5, c * 5 + 5);
      expect(new Set(group).size).toBe(1);
    }
    expect(new Set(membership).size).toBe(6);
    expect(modularity(30, edges, membership)).toBeGreaterThan(0.7);
  });

  it('is deterministic', () => {
    const edges = ringOfCliques(8, 6);
    expect(louvain(48, edges)).toEqual(louvain(48, edges));
  });

  it('treats edge weight as strength of connection', () => {
    // 0-1 and 2-3 strongly tied, weakly linked across.
    const membership = louvain(4, [
      [0, 1, 10],
      [2, 3, 10],
      [1, 2, 1],
    ]);
    expect(membership[0]).toBe(membership[1]);
    expect(membership[2]).toBe(membership[3]);
    expect(membership[0]).not.toBe(membership[2]);
  });

  it('higher resolution yields more communities', () => {
    const edges = ringOfCliques(10, 4);
    const coarse = new Set(louvain(40, edges, { resolution: 0.2 })).size;
    const fine = new Set(louvain(40, edges, { resolution: 1 })).size;
    expect(fine).toBeGreaterThanOrEqual(coarse);
  });

  it('handles empty, edgeless, and malformed input', () => {
    expect(louvain(0, [])).toEqual([]);
    expect(louvain(3, [])).toEqual([0, 1, 2]);
    expect(
      louvain(2, [
        [0, 9, 1],
        [0, 1, -1],
        [0, 1, Number.NaN],
      ]),
    ).toEqual([0, 1]);
  });

  it('scales to tens of thousands of nodes quickly', () => {
    const edges = ringOfCliques(2_000, 8); // 16k nodes, ~58k edges
    const started = performance.now();
    const membership = louvain(16_000, edges);
    expect(performance.now() - started).toBeLessThan(5_000);
    // Modularity's resolution limit merges neighbouring cliques at this scale (topics are size-
    // capped afterwards), but it never splits one.
    for (let c = 0; c < 2_000; c++) {
      expect(new Set(membership.slice(c * 8, c * 8 + 8)).size).toBe(1);
    }
  });
});
