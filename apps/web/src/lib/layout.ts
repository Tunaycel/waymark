import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { VisibleGraph } from './graph';

export const TOPIC_SIZE = { width: 232, height: 76 };
export const COLLAPSED_SIZE = { width: 252, height: 92 };
const GROUP_PADDING = '[top=56,left=24,bottom=24,right=24]';

export interface Positioned {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Position is relative to this parent node, as React Flow expects for grouped nodes. */
  parent: string | null;
}

interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

/**
 * Layered layout, dependencies flowing left to right: a topic sits left of the topics it imports.
 * Package regions are laid out together with their contents so edges between regions stay short.
 */
export async function layoutGraph(
  elk: ElkLike,
  graph: VisibleGraph,
): Promise<Map<string, Positioned>> {
  const children = new Map<string | null, ElkNode[]>();
  const push = (parent: string | null, node: ElkNode) => {
    const list = children.get(parent) ?? [];
    list.push(node);
    children.set(parent, list);
  };

  // ELK throws on a duplicate id, an unknown parent, or an edge to a missing node; the canvas would
  // never appear. Drop such input here instead.
  const seen = new Set<string>();
  const boxes = new Set(graph.nodes.filter((n) => n.kind === 'region').map((n) => n.id));
  for (const n of graph.nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (n.kind === 'region') {
      push(null, {
        id: n.id,
        layoutOptions: { 'elk.padding': GROUP_PADDING },
        children: [],
      });
    } else if (n.kind === 'collapsed') {
      push(null, { id: n.id, ...COLLAPSED_SIZE });
    } else {
      push(n.parent && boxes.has(n.parent) ? n.parent : null, { id: n.id, ...TOPIC_SIZE });
    }
  }
  const roots = children.get(null) ?? [];
  for (const root of roots) {
    if (root.children) root.children = children.get(root.id) ?? [];
  }

  const edgeIds = new Set<string>();
  const edges: ElkExtendedEdge[] = graph.edges
    .filter((e) => {
      if (edgeIds.has(e.id) || !seen.has(e.source) || !seen.has(e.target)) return false;
      edgeIds.add(e.id);
      return true;
    })
    .map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    }));

  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '26',
      'elk.spacing.componentComponent': '60',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.separateConnectedComponents': 'true',
    },
    children: roots,
    edges,
  });

  const positions = new Map<string, Positioned>();
  const visit = (nodes: ElkNode[] | undefined, parent: string | null) => {
    for (const n of nodes ?? []) {
      positions.set(n.id, {
        id: n.id,
        x: n.x ?? 0,
        y: n.y ?? 0,
        width: n.width ?? TOPIC_SIZE.width,
        height: n.height ?? TOPIC_SIZE.height,
        parent,
      });
      visit(n.children, n.id);
    }
  };
  visit(result.children, null);
  return positions;
}
