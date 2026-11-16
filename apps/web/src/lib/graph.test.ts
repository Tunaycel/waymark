import type { MapTopic, RepositoryMap } from '@waymark/db';
import { describe, expect, it } from 'vitest';
import {
  COLLAPSE_THRESHOLD,
  collapsibleIds,
  containersOfTopic,
  expandOneLevel,
  initialCollapsed,
  MAX_REGIONS,
  neighbours,
  packageLabel,
  pruneEdges,
  regionEntries,
  regions,
  searchTopics,
  topicNodeId,
  visibleGraph,
} from './graph';

function topic(id: string, directory: string, pkg = '', extra: Partial<MapTopic> = {}): MapTopic {
  return {
    id,
    package: pkg,
    directory,
    name: id,
    summary: null,
    role: null,
    source: 'heuristic',
    fileCount: 1,
    testCount: 0,
    lineCount: 10,
    languages: {},
    externals: [],
    markerCount: 0,
    lastChangedAt: null,
    commits30d: 0,
    ...extra,
  } as MapTopic;
}

function repoMap(
  topics: MapTopic[],
  edges: RepositoryMap['edges'] = [],
  packages: RepositoryMap['packages'] = [],
): RepositoryMap {
  return {
    repository: { id: 'r', fullName: 'acme/app', defaultBranch: 'main', isPrivate: false },
    snapshot: {
      id: 's',
      commitSha: 'abc',
      indexedAt: new Date(0).toISOString(),
      fileCount: 1,
      truncated: false,
    },
    packages,
    topics,
    edges,
  } as RepositoryMap;
}

const many = (n: number, dir: (i: number) => string, pkg = '') =>
  Array.from({ length: n }, (_, i) => topic(`t${i}`, dir(i), pkg));

describe('regions', () => {
  it('uses one region per package and drops the npm scope from labels', () => {
    const map = repoMap(
      [
        topic('a', 'packages/api/src', 'packages/api'),
        topic('b', 'packages/web/src', 'packages/web'),
      ],
      [],
      [
        { id: 'packages/api', name: '@acme/api', description: null },
        { id: 'packages/web', name: '@acme/web', description: null },
      ],
    );
    expect(regions(map).map((r) => r.label)).toEqual(['api', 'web']);
    expect(packageLabel(map, '')).toBe('app');
  });

  it('splits a large package by directory, deeper only where an area is still large', () => {
    // 30 topics under src/core/* (split again) and 5 under src/ui.
    const topics = [
      ...many(30, (i) => `src/core/m${i % 6}`),
      ...Array.from({ length: 5 }, (_, i) => topic(`u${i}`, 'src/ui')),
    ];
    const labels = regions(repoMap(topics)).map((r) => r.label);
    // `src` is shared by everything, so the split starts below it.
    expect(labels).toContain('src/ui');
    expect(labels).toContain('src/core/m0');
    expect(labels).not.toContain('src');
    for (const r of regions(repoMap(topics))) expect(r.topics.length).toBeLessThanOrEqual(24);
  });

  it('keeps an area that cannot be split further whole', () => {
    const topics = many(40, () => 'src/flat');
    const all = regions(repoMap(topics));
    expect(all).toHaveLength(1);
    expect(all[0]?.topics).toHaveLength(40);
  });

  it('covers every topic exactly once', () => {
    const topics = many(200, (i) => `pkg${i % 7}/area${i % 13}/x${i % 3}`);
    const seen = regions(repoMap(topics)).flatMap((r) => r.topics.map((t) => t.id));
    expect(seen.sort()).toEqual(topics.map((t) => t.id).sort());
  });
});

describe('region groups', () => {
  // 120 one-topic packages: 100 under packages/<name>, 20 under fixtures/<name>.
  const topics = [
    ...Array.from({ length: 100 }, (_, i) =>
      topic(`p${i}`, `packages/p${i}/src`, `packages/p${i % 50}${i >= 50 ? `/nested/n${i}` : ''}`),
    ),
    ...Array.from({ length: 20 }, (_, i) => topic(`f${i}`, `fixtures/f${i}`, `fixtures/f${i}`)),
  ];
  const map = repoMap(topics);

  it('leaves few regions ungrouped', () => {
    const small = repoMap(many(10, (i) => `p${i}`).map((t, i) => ({ ...t, package: `p${i}` })));
    expect(regionEntries(small).every((e) => e.kind === 'region')).toBe(true);
  });

  it('groups many regions so no level shows more than the limit', () => {
    const check = (entries: ReturnType<typeof regionEntries>) => {
      expect(entries.length).toBeLessThanOrEqual(MAX_REGIONS);
      for (const e of entries) if (e.kind === 'group') check(e.group.children);
    };
    expect(regions(map).length).toBeGreaterThan(MAX_REGIONS);
    check(regionEntries(map));
  });

  it('starts with groups collapsed and expands the path to a searched topic', () => {
    const collapsed = initialCollapsed(map);
    const first = visibleGraph(map, collapsed);
    expect(first.nodes.length).toBeLessThanOrEqual(MAX_REGIONS);

    const path = containersOfTopic(map, 'p77');
    expect(path.length).toBeGreaterThanOrEqual(2);
    const open = new Set(collapsed);
    for (const id of path) open.delete(id);
    const after = visibleGraph(map, open);
    expect(after.nodes.some((n) => n.id === topicNodeId('p77'))).toBe(true);
  });

  it('cuts siblings no directory separates into alphabetical ranges, at any count', () => {
    const flat = repoMap(
      Array.from({ length: 1500 }, (_, i) => topic(`x${i}`, `pkgs/x${i}`, `pkgs/x${i}`)),
    );
    const levels: number[] = [];
    let covered = 0;
    const walk = (entries: ReturnType<typeof regionEntries>) => {
      levels.push(entries.length);
      for (const e of entries) {
        if (e.kind === 'group') walk(e.group.children);
        else covered++;
      }
    };
    walk(regionEntries(flat));
    expect(Math.max(...levels)).toBeLessThanOrEqual(MAX_REGIONS);
    expect(covered).toBe(1500);
    const ids = collapsibleIds(flat);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists every group and region as collapsible', () => {
    const ids = collapsibleIds(map);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of regions(map)) expect(ids).toContain(r.id);
    const everything = visibleGraph(map, new Set(ids));
    // Fully collapsed shows only top-level entries.
    expect(everything.nodes).toHaveLength(regionEntries(map).length);
  });
});

describe('visibleGraph', () => {
  const two = repoMap(
    [topic('a1', 'a/x', 'a'), topic('a2', 'a/y', 'a'), topic('b1', 'b', 'b')],
    [
      { from: 'a1', to: 'b1', weight: 2 },
      { from: 'a2', to: 'b1', weight: 3 },
      { from: 'a1', to: 'a2', weight: 1 },
    ],
  );

  it('boxes multi-topic regions and captions lone topics', () => {
    const g = visibleGraph(two, new Set());
    expect(g.nodes.filter((n) => n.kind === 'region').map((n) => n.id)).toEqual(['r:p:a']);
    const b1 = g.nodes.find((n) => n.id === topicNodeId('b1'));
    expect(b1).toMatchObject({ kind: 'topic', parent: null, caption: 'b' });
  });

  it('aggregates edges onto a collapsed region and drops its internal ones', () => {
    const g = visibleGraph(two, new Set(['p:a']));
    expect(g.nodes.map((n) => n.kind).sort()).toEqual(['collapsed', 'topic']);
    expect(g.edges).toEqual([{ id: 'r:p:a->t:b1', source: 'r:p:a', target: 't:b1', weight: 5 }]);
  });

  it('draws no boxes for a single-region repository', () => {
    const g = visibleGraph(repoMap([topic('x', 'src'), topic('y', 'src')]), new Set(['p:']));
    expect(g.nodes.every((n) => n.kind === 'topic')).toBe(true);
  });

  it('starts expanded below the threshold and collapsed above it', () => {
    expect(initialCollapsed(two).size).toBe(0);
    const big = repoMap(
      many(COLLAPSE_THRESHOLD + 1, (i) => `m${i % 3}/d${i}`).map((t, i) => ({
        ...t,
        package: `m${i % 3}`,
      })),
    );
    expect(initialCollapsed(big)).toEqual(new Set(['p:m0', 'p:m1', 'p:m2']));
  });
});

describe('pruneEdges', () => {
  const edges = ['b', 'c', 'd', 'e'].map((t, i) => ({
    id: `a->${t}`,
    source: 'a',
    target: t,
    weight: i + 1,
  }));

  it("keeps each node's three strongest outgoing edges", () => {
    expect(pruneEdges(edges, null).map((e) => e.target)).toEqual(['c', 'd', 'e']);
  });

  it('keeps every edge of the focused node', () => {
    expect(pruneEdges(edges, 'b')).toHaveLength(4);
  });
});

describe('neighbours and search', () => {
  const map = repoMap(
    [
      topic('auth', 'src/auth', '', { name: 'Auth Session' }),
      topic('db', 'src/db', '', { name: 'Database', summary: 'stores sessions' }),
      topic('ui', 'src/ui', '', { name: 'Login Form' }),
    ],
    [
      { from: 'ui', to: 'auth', weight: 2 },
      { from: 'auth', to: 'db', weight: 5 },
      { from: 'auth', to: 'auth', weight: 9 },
    ],
  );

  it('splits neighbours by direction and ignores self edges', () => {
    const n = neighbours(map, 'auth');
    expect(n.uses.map((x) => x.topic.id)).toEqual(['db']);
    expect(n.usedBy.map((x) => x.topic.id)).toEqual(['ui']);
  });

  it('ranks name prefix over name substring over directory or summary', () => {
    expect(searchTopics(map, 'log').map((t) => t.id)).toEqual(['ui']);
    expect(searchTopics(map, 'stores').map((t) => t.id)).toEqual(['db']);
    expect(searchTopics(map, 'session').map((t) => t.id)).toEqual(['auth', 'db']);
    expect(searchTopics(map, '  ')).toEqual([]);
  });
});

describe('ids', () => {
  it('never collide, whatever the directory names contain', () => {
    // Package `a` splits into area `b`; another package is literally named `a::b`, `group:x`, `p:a`.
    const tricky = [
      ...many(13, (i) => `a/b/x${i}`, 'a'),
      ...many(13, (i) => `a/c/x${i}`, 'a').map((t) => ({ ...t, id: `${t.id}c` })),
      topic('q1', 'a::b', 'a::b'),
      topic('q2', 'group:x', 'group:x'),
      topic('q3', 'p:a', 'p:a'),
      topic('q4', 'p:a/a:b', 'p:a/a:b'),
    ];
    const ids = regions(repoMap(tricky)).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const g = visibleGraph(repoMap(tricky), new Set());
    const nodeIds = g.nodes.map((n) => n.id);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
  });
});

describe('alphabetical ranges', () => {
  it('cuts 40 siblings into several ranges, not two halves', () => {
    const flat = repoMap(
      Array.from({ length: 40 }, (_, i) =>
        topic(
          `k${i}`,
          `deep/dir/k${String(i).padStart(2, '0')}`,
          `deep/dir/k${String(i).padStart(2, '0')}`,
        ),
      ),
    );
    const top = regionEntries(flat);
    expect(top.length).toBeGreaterThanOrEqual(5);
    expect(top.length).toBeLessThanOrEqual(MAX_REGIONS);
    const first = top[0];
    // The shared directory is said once in a range label.
    if (first?.kind === 'group') expect(first.group.label).toMatch(/^\S+ … k\d+$/);
  });
});

describe('expandOneLevel', () => {
  it('opens only what is visible, one level per call', () => {
    const map = repoMap(
      Array.from({ length: 120 }, (_, i) =>
        topic(`t${i}`, `packages/p${i}/src`, `packages/p${i}`),
      ).concat(
        Array.from({ length: 40 }, (_, i) => topic(`f${i}`, `fixtures/f${i}`, `fixtures/f${i}`)),
      ),
    );
    const start = initialCollapsed(map);
    const first = visibleGraph(map, start).nodes.length;
    const once = expandOneLevel(map, start);
    expect(once.size).toBeLessThan(start.size);
    const second = visibleGraph(map, once).nodes.length;
    expect(second).toBeGreaterThan(first);
    // Still bounded: nested ranges stay collapsed.
    expect(second).toBeLessThanOrEqual(MAX_REGIONS * MAX_REGIONS);
    let all = start;
    for (let i = 0; i < 10 && all.size > 0; i++) all = expandOneLevel(map, all);
    expect(all.size).toBe(0);
  });
});
