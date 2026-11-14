import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import type { VisibleGraph } from './graph';
import { COLLAPSED_SIZE, layoutGraph, TOPIC_SIZE } from './layout';

const topicNode = (id: string, parent: string | null = null) =>
  ({ kind: 'topic', id, parent, topic: {} as never, caption: null }) as const;

describe('layoutGraph', () => {
  const graph: VisibleGraph = {
    nodes: [
      { kind: 'region', id: 'r:a', regionId: 'a', label: 'a', topicCount: 2 },
      topicNode('t:a1', 'r:a'),
      topicNode('t:a2', 'r:a'),
      {
        kind: 'collapsed',
        id: 'r:b',
        regionId: 'b',
        label: 'b',
        topicCount: 5,
        fileCount: 9,
        markerCount: 0,
        lastChangedAt: null,
      },
      topicNode('t:c'),
    ],
    edges: [
      { id: 't:a1->r:b', source: 't:a1', target: 'r:b', weight: 1 },
      { id: 't:c->t:a2', source: 't:c', target: 't:a2', weight: 1 },
    ],
  };

  it('positions every node, children relative to their region', async () => {
    const positions = await layoutGraph(new ELK(), graph);
    expect([...positions.keys()].sort()).toEqual(['r:a', 'r:b', 't:a1', 't:a2', 't:c']);
    expect(positions.get('t:a1')?.parent).toBe('r:a');
    expect(positions.get('r:b')).toMatchObject({ parent: null, ...COLLAPSED_SIZE });
    expect(positions.get('t:c')).toMatchObject({ parent: null, ...TOPIC_SIZE });

    // Children fit inside their region.
    const region = positions.get('r:a');
    for (const id of ['t:a1', 't:a2']) {
      const p = positions.get(id);
      expect(p && region && p.x + p.width <= region.width && p.y + p.height <= region.height).toBe(
        true,
      );
    }
  });

  it('flows dependencies left to right', async () => {
    const positions = await layoutGraph(new ELK(), graph);
    const x = (id: string) => {
      const p = positions.get(id);
      const parent = p?.parent ? positions.get(p.parent) : undefined;
      return (p?.x ?? 0) + (parent?.x ?? 0);
    };
    expect(x('t:c')).toBeLessThan(x('t:a2'));
    expect(x('t:a1')).toBeLessThan(x('r:b'));
  });

  it('lays out malformed input instead of throwing', async () => {
    const bad: VisibleGraph = {
      nodes: [topicNode('t:x', 'r:missing'), topicNode('t:x'), topicNode('t:y')],
      edges: [
        { id: 'e', source: 't:x', target: 't:y', weight: 1 },
        { id: 'e', source: 't:x', target: 't:y', weight: 1 },
        { id: 'f', source: 't:x', target: 't:nowhere', weight: 1 },
      ],
    };
    const positions = await layoutGraph(new ELK(), bad);
    expect([...positions.keys()].sort()).toEqual(['t:x', 't:y']);
    expect(positions.get('t:x')?.parent).toBeNull();
  });

  it('handles an empty graph', async () => {
    expect((await layoutGraph(new ELK(), { nodes: [], edges: [] })).size).toBe(0);
  });
});
