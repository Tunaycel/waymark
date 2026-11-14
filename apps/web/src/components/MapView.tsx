'use client';

import '@xyflow/react/dist/style.css';
import type { RepositoryMap } from '@waymark/db';
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import { Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { heatOf, ROLE_LABELS } from '@/lib/format';
import {
  collapsibleIds,
  containersOfTopic,
  contentsOf,
  EXPAND_ALL_LIMIT,
  expandOneLevel,
  initialCollapsed,
  MAX_VISIBLE_NODES,
  regionNodeId,
  searchTopics,
  topicNodeId,
  type VisibleGraph,
  visibleGraph,
} from '@/lib/graph';
import { layoutGraph } from '@/lib/layout';
import { nodeTypes } from './nodes';
import { TopicPanel } from './TopicPanel';

const elk = new ELK();

/** Zoom used when centring on one topic: close enough to read it, with its neighbours around. */
const FOCUS_FIT = { padding: 1.6, maxZoom: 0.9 };

const TOOL_BUTTON =
  'rounded-xl border border-line bg-bg/85 px-3 py-2 text-xs text-muted backdrop-blur-md hover:border-line-strong hover:text-text focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted';

export function MapView({
  map,
  initialTopic,
}: {
  map: RepositoryMap;
  initialTopic?: string | undefined;
}) {
  return (
    <ReactFlowProvider>
      <Canvas map={map} initialTopic={initialTopic} />
    </ReactFlowProvider>
  );
}

function Canvas({ map, initialTopic }: { map: RepositoryMap; initialTopic?: string | undefined }) {
  const flow = useReactFlow();
  const [collapsed, setCollapsed] = useState(() => initialCollapsed(map));
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [laidOut, setLaidOut] = useState<{
    graph: VisibleGraph;
    nodes: Node[];
    /** The collapsed set this layout was made for (focus edges are computed against it). */
    collapsed: ReadonlySet<string>;
    /** Nodes the initial fit frames instead of the whole map. */
    fitTo: string[];
  } | null>(null);
  const fitTarget = useRef<string[]>([]);
  const [layoutError, setLayoutError] = useState(false);
  const [query, setQuery] = useState('');
  // Bumped on every new layout: remounting the canvas lets its built-in fit run on measured nodes.
  const [layoutVersion, setLayoutVersion] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const topicsById = useMemo(() => new Map(map.topics.map((t) => [t.id, t])), [map]);

  const graph = useMemo(() => visibleGraph(map, collapsed), [map, collapsed]);

  // Layout whenever the visible structure changes (expand/collapse), not on hover or selection.
  useEffect(() => {
    let cancelled = false;
    setLayoutError(false);
    layoutGraph(elk, graph)
      .then((positions) => {
        if (cancelled) return;
        const nodes: Node[] = graph.nodes.map((n) => {
          const p = positions.get(n.id);
          const base = {
            id: n.id,
            position: { x: p?.x ?? 0, y: p?.y ?? 0 },
            ...(p?.parent ? { parentId: p.parent, extent: 'parent' as const } : {}),
            draggable: false,
          };
          if (n.kind === 'region') {
            return {
              ...base,
              type: 'region',
              selectable: false,
              style: { width: p?.width, height: p?.height },
              zIndex: -1,
              data: { label: n.label, topicCount: n.topicCount, dimmed: false },
            };
          }
          if (n.kind === 'collapsed') {
            return { ...base, type: 'collapsed', data: { ...n, dimmed: false } };
          }
          return {
            ...base,
            type: 'topic',
            data: { topic: n.topic, caption: n.caption, dimmed: false, selected: false },
          };
        });
        const fitTo = fitTarget.current.filter((id) => positions.has(id));
        fitTarget.current = [];
        setLaidOut({ graph, nodes, collapsed, fitTo });
        // The old canvas is gone: a hover it started never gets its mouseleave.
        setHovered(null);
        setLayoutVersion((v) => v + 1);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('map layout failed', error);
        setLayoutError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [graph, collapsed]);

  // Ids that can carry focus in the current layout: topics and collapsed regions (not boxes).
  const focusable = useMemo(
    () => new Set(laidOut?.nodes.filter((n) => n.type !== 'region').map((n) => n.id) ?? []),
    [laidOut],
  );
  // A selected topic whose region was collapsed is no longer on the canvas: drop the selection.
  useEffect(() => {
    if (selected && laidOut && !focusable.has(selected)) setSelected(null);
  }, [selected, laidOut, focusable]);

  // Focus: the selected (or hovered) topic and its direct neighbours stay lit, the rest dims.
  // Only ids drawn in the current layout count, so a stale id can never dim the whole map.
  const focus = [selected, hovered].find((id) => id !== null && focusable.has(id)) ?? null;
  const shownEdges = useMemo(() => {
    if (!laidOut) return [];
    // Edges come from the laid-out state, so they always point at nodes that are drawn.
    return focus ? visibleGraph(map, laidOut.collapsed, focus).edges : laidOut.graph.edges;
  }, [map, focus, laidOut]);
  const focusSet = useMemo(() => {
    if (!focus || !laidOut) return null;
    const lit = new Set([focus]);
    for (const e of shownEdges) {
      if (e.source === focus) lit.add(e.target);
      if (e.target === focus) lit.add(e.source);
    }
    return lit;
  }, [focus, laidOut, shownEdges]);

  const nodes = useMemo(() => {
    if (!laidOut) return [];
    return laidOut.nodes.map((n) => {
      if (n.type === 'region') return n;
      const dimmed = focusSet ? !focusSet.has(n.id) : false;
      return { ...n, data: { ...n.data, dimmed, selected: n.id === selected } };
    });
  }, [laidOut, focusSet, selected]);

  const edges: Edge[] = useMemo(() => {
    if (!laidOut) return [];
    const max = Math.max(1, ...shownEdges.map((e) => e.weight));
    return shownEdges.map((e) => {
      const active = focus ? e.source === focus || e.target === focus : false;
      const width = 1 + 3.5 * (Math.log(1 + e.weight) / Math.log(1 + max));
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'default',
        animated: active,
        style: {
          stroke: active ? 'var(--accent)' : 'var(--line-strong)',
          strokeWidth: width,
          opacity: focus && !active ? 0.08 : active ? 0.95 : 0.55,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: active ? 'var(--accent)' : 'rgb(148 163 184 / 0.4)',
        },
        label: active && e.weight > 1 ? String(e.weight) : undefined,
        labelStyle: { fill: 'var(--text-muted)', fontSize: 11 },
        labelBgStyle: { fill: 'var(--bg)' },
      };
    });
  }, [laidOut, focus, shownEdges]);

  const selectTopic = useCallback(
    (topicId: string) => {
      const topic = topicsById.get(topicId);
      if (!topic) return;
      const hidden = containersOfTopic(map, topicId).filter((id) => collapsed.has(id));
      const id = topicNodeId(topicId);
      setSelected(id);
      if (hidden.length > 0 || !laidOut) {
        // The canvas (re-)lays out and remounts; its initial fit centres on the node.
        fitTarget.current = [id];
        if (hidden.length === 0) return;
        const next = new Set(collapsed);
        for (const c of hidden) next.delete(c);
        setCollapsed(next);
        return;
      }
      flow.fitView({ nodes: [{ id }], ...FOCUS_FIT, duration: 450 });
    },
    [topicsById, collapsed, flow, map, laidOut],
  );

  // `?topic=<id>` opens the map on that topic (links from briefs, shared URLs).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !initialTopic) return;
    opened.current = true;
    selectTopic(initialTopic);
  }, [initialTopic, selectTopic]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      if (node.type === 'collapsed') {
        const regionId = (node.data as { regionId: string }).regionId;
        // Frame what opens, not the whole map.
        const inside = contentsOf(map, regionId);
        fitTarget.current = [
          ...inside.containers.map(regionNodeId),
          ...inside.topics.map(topicNodeId),
        ];
        const next = new Set(collapsed);
        next.delete(regionId);
        setCollapsed(next);
        return;
      }
      if (node.type === 'topic') setSelected((s) => (s === node.id ? null : node.id));
    },
    [collapsed, map],
  );

  // Ctrl/Cmd+K focuses search; Escape clears selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape') {
        setSelected(null);
        setQuery('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = useMemo(() => searchTopics(map, query), [map, query]);
  const selectedTopic = selected ? topicsById.get(selected.slice(2)) : undefined;
  const allRegions = useMemo(() => collapsibleIds(map), [map]);
  // A full layout of a large map blocks the page for seconds: open it one level per click.
  const stepwise = map.topics.length > EXPAND_ALL_LIMIT;
  // What the expand button would show, if laying it out stays fast (ELK runs on this thread).
  const expansion = useMemo(() => {
    if (collapsed.size === 0) return null;
    const next = stepwise ? expandOneLevel(map, collapsed) : new Set<string>();
    return visibleGraph(map, next).nodes.length <= MAX_VISIBLE_NODES ? next : null;
  }, [map, collapsed, stepwise]);

  return (
    <div className="relative min-h-0 flex-1">
      <ReactFlow
        key={layoutVersion}
        fitView
        fitViewOptions={
          laidOut && laidOut.fitTo.length === 1
            ? { nodes: [{ id: laidOut.fitTo[0] as string }], ...FOCUS_FIT }
            : laidOut && laidOut.fitTo.length > 1
              ? { nodes: laidOut.fitTo.map((id) => ({ id })), padding: 0.12, maxZoom: 1 }
              : { padding: 0.08 }
        }
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={(_, n) => n.type !== 'region' && setHovered(n.id)}
        onNodeMouseLeave={() => setHovered(null)}
        onPaneClick={() => setSelected(null)}
        minZoom={0.08}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={28}
          size={1}
          color="rgb(148 163 184 / 0.12)"
        />
        <Controls showInteractive={false} position="bottom-left" />
        {/* The side panel covers the minimap's corner; the panel is the focus then anyway. */}
        {!selectedTopic && (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            // SVG attributes don't resolve CSS variables: concrete colours here.
            nodeColor={(n) => {
              if (n.type === 'region') return 'rgba(148, 163, 184, 0.06)';
              const changed =
                n.type === 'topic'
                  ? (n.data as { topic: { lastChangedAt: string | null } }).topic.lastChangedAt
                  : ((n.data as { lastChangedAt?: string | null }).lastChangedAt ?? null);
              return heatOf(changed) !== 'cold' ? '#38bdf8' : 'rgba(148, 163, 184, 0.45)';
            }}
            maskColor="rgb(6 10 19 / 0.75)"
          />
        )}
      </ReactFlow>

      {layoutError ? (
        <div className="absolute inset-0 z-20 grid place-items-center">
          <div className="max-w-sm rounded-xl border border-line bg-panel px-5 py-4 text-center text-sm text-muted">
            <p>This view could not be laid out.</p>
            <button
              type="button"
              onClick={() => setCollapsed(new Set(allRegions))}
              className="mt-3 rounded-lg border border-line px-3 py-1.5 text-xs text-text hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent"
            >
              Collapse all and retry
            </button>
          </div>
        </div>
      ) : !laidOut ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-faint">
          Laying out {map.topics.length} topics…
        </div>
      ) : (
        laidOut.collapsed !== collapsed && (
          <div
            role="status"
            className="pointer-events-none absolute bottom-16 left-1/2 z-10 -translate-x-1/2 rounded-full border border-line bg-bg/90 px-3 py-1 text-xs text-muted"
          >
            Laying out…
          </div>
        )
      )}

      <div className="absolute left-4 top-4 z-10 w-[min(340px,calc(100%-2rem))]">
        <label className="flex items-center gap-2 rounded-xl border border-line bg-bg/85 px-3 py-2 backdrop-blur-md focus-within:border-accent/60">
          <Search className="size-4 text-faint" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) {
                selectTopic(results[0].id);
                setQuery('');
              }
            }}
            placeholder="Find a topic…"
            className="w-full bg-transparent text-sm text-text placeholder:text-faint focus:outline-none"
            aria-label="Find a topic"
          />
          <kbd className="whitespace-nowrap rounded border border-line px-1.5 text-[10px] text-faint">
            Ctrl K
          </kbd>
        </label>
        {results.length > 0 && (
          <ul className="mt-2 overflow-hidden rounded-xl border border-line bg-bg/95 backdrop-blur-md">
            {results.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => {
                    selectTopic(t.id);
                    setQuery('');
                  }}
                  className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-panel focus-visible:bg-panel focus-visible:outline-none"
                >
                  <span className="truncate text-sm text-text">{t.name}</span>
                  <span className="truncate text-xs text-faint">{t.directory}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div
        className="absolute right-4 top-4 z-10 flex gap-2"
        style={selectedTopic ? { right: 'min(436px, 100%)' } : undefined}
      >
        {collapsed.size > 0 && (
          <button
            type="button"
            disabled={!expansion}
            title={
              expansion
                ? undefined
                : 'Too many nodes to lay out at once: open regions by clicking them, or search'
            }
            onClick={() => expansion && setCollapsed(expansion)}
            className={TOOL_BUTTON}
          >
            {stepwise ? 'Expand a level' : 'Expand all'}
          </button>
        )}
        {allRegions.length > 1 && collapsed.size < allRegions.length && (
          <button
            type="button"
            onClick={() => setCollapsed(new Set(allRegions))}
            className={TOOL_BUTTON}
          >
            Collapse all
          </button>
        )}
      </div>

      <Legend />

      {selectedTopic && (
        <TopicPanel
          map={map}
          topic={selectedTopic}
          onSelect={selectTopic}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function Legend() {
  const roles = [
    'feature',
    'api',
    'ui',
    'data',
    'infrastructure',
    'integration',
    'tooling',
    'tests',
  ];
  return (
    <div className="pointer-events-none absolute bottom-4 left-16 z-10 hidden flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-bg/80 px-3 py-2 text-[11px] text-faint backdrop-blur-md md:flex">
      <span className="inline-flex items-center gap-1.5">
        <span className="live-pulse size-2 rounded-full bg-live" /> changed today
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-live opacity-60" /> this week
      </span>
      <span className="mx-1 h-3 w-px bg-line-strong" />
      {roles.map((r) => (
        <span key={r} className="inline-flex items-center gap-1">
          <span className="h-2.5 w-1 rounded-full" style={{ background: `var(--role-${r})` }} />
          {ROLE_LABELS[r]}
        </span>
      ))}
    </div>
  );
}
