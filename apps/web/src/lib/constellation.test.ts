import type { Constellation } from '@waymark/db';
import { describe, expect, it } from 'vitest';
import {
  bounds,
  clusterRadius,
  layoutConstellations,
  type OverviewProject,
  type PlacedProject,
  signalRoutes,
  starSize,
} from './constellation';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function project(id: string, stars: number, links: [number, number][] = []): OverviewProject {
  const constellation: Constellation = {
    stars: Array.from({ length: stars }, (_, i) => ({
      lines: 10_000 / (i + 1),
      lastChangedAt: i === 0 ? hoursAgo(2) : i === 1 ? hoursAgo(72) : null,
    })),
    links,
    hidden: 0,
  };
  return { id, fullName: `acme/${id}`, commits7d: 1, topicCount: stars, constellation };
}

const dist = (a: number[], b: number[]) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

describe('layoutConstellations', () => {
  it('is deterministic', () => {
    const input = [project('a', 40, [[0, 5]]), project('b', 12), project('c', 300)];
    expect(layoutConstellations(input, NOW)).toEqual(layoutConstellations(input, NOW));
  });

  it('never lets two clusters overlap, even with many projects', () => {
    const many = Array.from({ length: 40 }, (_, i) => project(`p${i}`, (i * 37) % 360 || 1));
    const placed = layoutConstellations(many, NOW);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        if (!a || !b) continue;
        expect(dist(a.center, b.center)).toBeGreaterThanOrEqual(a.radius + b.radius);
      }
    }
  });

  it('keeps every star inside its cluster, finite, with the largest at the core', () => {
    const [p] = layoutConstellations(
      [
        project('a', 360, [
          [0, 359],
          [3, 200],
        ]),
      ],
      NOW,
    );
    expect(p?.stars).toHaveLength(360);
    for (const s of p?.stars ?? []) {
      expect(s.position.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...s.position)).toBeLessThanOrEqual((p?.radius ?? 0) + 1e-9);
    }
    const r = (i: number) => Math.hypot(...(p?.stars[i]?.position ?? [0, 0, 0]));
    expect(r(0)).toBeLessThan(r(300));
  });

  it('colours stars by how recently their topic changed', () => {
    const [p] = layoutConstellations([project('a', 3)], NOW);
    expect(p?.stars.map((s) => s.heat)).toEqual(['live', 'warm', 'cold']);
  });

  it('ignores links to stars that are not drawn and self-links', () => {
    const [p] = layoutConstellations(
      [
        project('a', 3, [
          [0, 9],
          [1, 1],
          [0, 2],
        ]),
      ],
      NOW,
    );
    expect(p?.links).toEqual([[0, 2]]);
  });

  it('handles empty projects and an empty sky', () => {
    expect(layoutConstellations([], NOW)).toEqual([]);
    const [p] = layoutConstellations([project('empty', 0)], NOW);
    expect(p?.stars).toEqual([]);
    expect(bounds([]).radius).toBeGreaterThan(0);
  });

  it('frames every cluster', () => {
    const placed = layoutConstellations(
      [project('a', 50), project('b', 5), project('c', 200)],
      NOW,
    );
    const { center, radius } = bounds(placed);
    for (const p of placed)
      expect(dist(p.center, center) + p.radius).toBeLessThanOrEqual(radius + 1e-9);
  });
});

describe('sizes', () => {
  it('grow with content, slowly', () => {
    expect(clusterRadius(360)).toBeGreaterThan(clusterRadius(10));
    expect(starSize(100_000)).toBeGreaterThan(starSize(10));
    expect(starSize(100_000) / starSize(10)).toBeLessThan(3);
    expect(starSize(-5)).toBeGreaterThan(0);
  });
});

describe('robustness', () => {
  it('places 500 projects quickly', () => {
    const many = Array.from({ length: 500 }, (_, k) => project(`p${k}`, (k * 37) % 360 || 1));
    const started = performance.now();
    const placed = layoutConstellations(many, NOW);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(placed).toHaveLength(500);
  });

  it('draws a two-way import as one line', () => {
    const [p] = layoutConstellations(
      [
        project('a', 3, [
          [0, 1],
          [1, 0],
          [0, 1],
        ]),
      ],
      NOW,
    );
    expect(p?.links).toEqual([[0, 1]]);
  });

  it('keeps star sizes finite whatever the line count', () => {
    for (const lines of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(Number.isFinite(starSize(lines))).toBe(true);
    }
  });
});

describe('signalRoutes', () => {
  it('sends signals along links touching recent work first', () => {
    // Star 0 changed today, 1 this week, the rest are quiet.
    const [p] = layoutConstellations(
      [
        project('a', 6, [
          [3, 4],
          [2, 5],
          [1, 3],
          [0, 2],
        ]),
      ],
      NOW,
    );
    const routes = signalRoutes(p as PlacedProject);
    expect(routes.map((r) => r.energy)).toEqual(['live', 'warm', 'cold', 'cold']);
    expect(routes[0]).toMatchObject({ from: 0, to: 2 });
  });

  it('keeps only a few slow signals in a quiet project', () => {
    const quiet = project(
      'q',
      40,
      Array.from({ length: 30 }, (_, i) => [i + 2, i + 3]),
    );
    const [p] = layoutConstellations([quiet], NOW);
    const routes = signalRoutes(p as PlacedProject, 48, 10);
    expect(routes).toHaveLength(10);
    expect(routes.every((r) => r.energy === 'cold')).toBe(true);
  });

  it('caps a busy project', () => {
    const busy = project(
      'b',
      120,
      Array.from({ length: 100 }, (_, i) => [0, i + 1]),
    );
    const [p] = layoutConstellations([busy], NOW);
    expect(signalRoutes(p as PlacedProject, 48)).toHaveLength(48);
  });
});

describe('signalRoutes edges', () => {
  const placed = (stars: number, links: [number, number][]) =>
    layoutConstellations([project('e', stars, links)], NOW)[0] as PlacedProject;

  it('runs from the hotter end even when the link is stored the other way', () => {
    // Star 0 changed today; the link is stored quiet -> live.
    expect(signalRoutes(placed(4, [[3, 0]]))).toEqual([{ from: 0, to: 3, energy: 'live' }]);
  });

  it('adds only a few quiet routes when one link is hot', () => {
    const links: [number, number][] = [
      [0, 2],
      ...Array.from({ length: 200 }, (_, i): [number, number] => [i + 3, i + 4]),
    ];
    const routes = signalRoutes(placed(220, links), 48, 10);
    expect(routes.filter((r) => r.energy !== 'cold')).toHaveLength(1);
    expect(routes).toHaveLength(11);
  });

  it('handles no links, links to missing stars, and keeps the stored order among equals', () => {
    expect(signalRoutes(placed(3, []))).toEqual([]);
    expect(signalRoutes(placed(3, [[0, 9]]))).toEqual([]);
    const routes = signalRoutes(
      placed(10, [
        [5, 6],
        [3, 4],
        [7, 8],
      ]),
    );
    expect(routes.map((r) => [r.from, r.to])).toEqual([
      [5, 6],
      [3, 4],
      [7, 8],
    ]);
  });
});
