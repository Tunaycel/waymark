import type { MapTopic, RepositoryMap } from '@waymark/db';

/**
 * Turns a repository map into what the canvas shows: regions (packages, or directory areas inside
 * a large package) as boxes or, when collapsed, as single nodes; topics as nodes; imports as
 * weighted edges aggregated to whatever is visible and pruned to the strongest when nothing is
 * focused. Pure: no layout, no React. Layout happens in `layout.ts`.
 */

export type VisibleNode =
  | { kind: 'region'; id: string; regionId: string; label: string; topicCount: number }
  | {
      kind: 'collapsed';
      id: string;
      regionId: string;
      label: string;
      topicCount: number;
      fileCount: number;
      markerCount: number;
      lastChangedAt: string | null;
    }
  | {
      kind: 'topic';
      id: string;
      parent: string | null;
      topic: MapTopic;
      /** Region name shown on the node when it has no box around it (a one-topic region). */
      caption: string | null;
    };

export interface VisibleEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
}

export interface VisibleGraph {
  nodes: VisibleNode[];
  edges: VisibleEdge[];
}

export interface Region {
  id: string;
  label: string;
  topics: MapTopic[];
  /** Directory the region covers, relative to the repository root ('' for the root). */
  dir: string;
}

/** Several regions under one directory, shown as one collapsible unit when regions are many. */
export interface RegionGroup {
  id: string;
  label: string;
  /** Every region inside the group, at any depth. */
  regions: Region[];
  /** What the group expands into: regions, or smaller groups when it holds too many. */
  children: RegionEntry[];
}

export type RegionEntry =
  | { kind: 'region'; region: Region }
  | { kind: 'group'; group: RegionGroup };

/** Above this many topics, regions start collapsed so the first view stays readable. */
export const COLLAPSE_THRESHOLD = 60;
/** A package with more topics than this is split into directory areas. */
const AREA_SPLIT = 24;
/** Above this many regions, regions under the same directory are grouped. */
export const MAX_REGIONS = 32;
/** Without focus, each node keeps only its strongest outgoing edges. */
const EDGES_PER_NODE = 3;

export const topicNodeId = (topicId: string) => `t:${topicId}`;
export const regionNodeId = (regionId: string) => `r:${regionId}`;

export function packageLabel(map: RepositoryMap, packageId: string): string {
  const pkg = map.packages.find((p) => p.id === packageId);
  // `@acme/billing` → `billing`: the scope is the same for every package of a monorepo.
  if (pkg?.name) return pkg.name.replace(/^@[^/]+\//, '');
  if (packageId === '') return map.repository.fullName.split('/').at(-1) ?? 'root';
  return packageId;
}

const relative = (pkg: string, dir: string) =>
  pkg && dir.startsWith(`${pkg}/`) ? dir.slice(pkg.length + 1) : pkg === dir ? '' : dir;

function areaOf(pkg: string, t: MapTopic, depth: number): string {
  const parts = relative(pkg, t.directory).split('/').filter(Boolean);
  return parts.slice(0, depth).join('/');
}

/** Directory levels a large package may be split into before regions stop shrinking. */
const MAX_AREA_DEPTH = 6;

/**
 * Splits a package's topics by directory, one level at a time: a level shared by every topic is
 * skipped, and any area still larger than `AREA_SPLIT` is split one level deeper.
 */
function splitAreas(
  pkg: string,
  topics: MapTopic[],
  depth: number,
): { area: string; topics: MapTopic[] }[] {
  const groups = new Map<string, MapTopic[]>();
  for (const t of topics) {
    const area = areaOf(pkg, t, depth);
    const list = groups.get(area);
    if (list) list.push(t);
    else groups.set(area, [t]);
  }
  if (depth >= MAX_AREA_DEPTH) return [...groups].map(([area, ts]) => ({ area, topics: ts }));
  // Everything under one directory: look one level deeper.
  if (groups.size === 1) return splitAreas(pkg, topics, depth + 1);
  return [...groups].flatMap(([area, ts]) =>
    ts.length > AREA_SPLIT && ts.some((t) => areaOf(pkg, t, depth + 1) !== area)
      ? splitAreas(pkg, ts, depth + 1)
      : [{ area, topics: ts }],
  );
}

/**
 * Ids of regions and groups. Path parts are URI-encoded, so the separators (`:` `/`) can never come
 * from a directory name and two different regions can never share an id.
 */
const enc = encodeURIComponent;
const regionId = (pkg: string, area?: string) =>
  area === undefined ? `p:${enc(pkg)}` : `p:${enc(pkg)}/a:${enc(area)}`;
const groupId = (key: string) => `g:${enc(key)}`;

/** Regions: one per package, and one per directory area inside packages with many topics. */
const regionsCache = new WeakMap<RepositoryMap, Region[]>();

export function regions(map: RepositoryMap): Region[] {
  const cached = regionsCache.get(map);
  if (cached) return cached;
  const byPackage = new Map<string, MapTopic[]>();
  for (const t of map.topics) {
    const list = byPackage.get(t.package);
    if (list) list.push(t);
    else byPackage.set(t.package, [t]);
  }
  const out: Region[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const topics = byPackage.get(pkg) as MapTopic[];
    const label = packageLabel(map, pkg);
    if (topics.length <= AREA_SPLIT) {
      out.push({ id: regionId(pkg), label, topics, dir: pkg });
      continue;
    }
    const areas = new Map(splitAreas(pkg, topics, 1).map((a) => [a.area, a.topics]));
    const multiPackage = byPackage.size > 1;
    for (const area of [...areas.keys()].sort()) {
      out.push({
        id: regionId(pkg, area),
        label: area ? (multiPackage ? `${label} / ${area}` : area) : label,
        topics: areas.get(area) as MapTopic[],
        dir: [pkg, area].filter(Boolean).join('/'),
      });
    }
  }
  regionsCache.set(map, out);
  return out;
}

const groupKey = (dir: string, depth: number) =>
  dir.split('/').filter(Boolean).slice(0, depth).join('/');

const entriesCache = new WeakMap<RepositoryMap, RegionEntry[]>();

/**
 * What the canvas shows at the top level. With few regions, every region. With many (a monorepo
 * with hundreds of packages and fixtures), regions are grouped by the finest directory level that
 * keeps the count at `MAX_REGIONS` or under; a group expands into its regions.
 */
export function regionEntries(map: RepositoryMap): RegionEntry[] {
  const cached = entriesCache.get(map);
  if (cached) return cached;
  const entries = groupRegions(map, regions(map), 1, '');
  entriesCache.set(map, entries);
  return entries;
}

const depthOf = (dir: string) => dir.split('/').filter(Boolean).length;

/**
 * Groups regions by directory when there are too many to show side by side, recursively: a group
 * that is itself too large to expand into a readable view is split the same way one level down.
 */
function groupRegions(
  map: RepositoryMap,
  list: Region[],
  minDepth: number,
  parentKey: string,
): RegionEntry[] {
  const flat = list.map((region): RegionEntry => ({ kind: 'region', region }));
  if (list.length <= MAX_REGIONS) return flat;
  const maxDepth = list.reduce((m, r) => Math.max(m, depthOf(r.dir)), 0);
  const keysAt = (d: number) => new Set(list.map((r) => groupKey(r.dir, d))).size;
  // Skip levels every region shares: they would make a single group around everything.
  let depth = minDepth;
  while (depth < maxDepth && keysAt(depth) === 1) depth++;
  if (keysAt(depth) === 1) return bucket(flat, `${groupId(parentKey)}/d:${depth}`);
  // Then go as fine as the limit allows.
  while (depth < maxDepth && keysAt(depth + 1) <= MAX_REGIONS) depth++;

  const byKey = new Map<string, Region[]>();
  for (const r of list) {
    const key = groupKey(r.dir, depth);
    const members = byKey.get(key);
    if (members) members.push(r);
    else byKey.set(key, [r]);
  }
  const entries = [...byKey].map(([key, rs]): RegionEntry => {
    if (rs.length === 1) return { kind: 'region', region: rs[0] as Region };
    const label =
      parentKey && key.startsWith(`${parentKey}/`)
        ? key.slice(parentKey.length + 1)
        : key || packageLabel(map, '');
    return {
      kind: 'group',
      group: {
        id: groupId(key),
        label,
        regions: rs,
        children: groupRegions(map, rs, depth + 1, key),
      },
    };
  });
  return bucket(entries, `${groupId(parentKey)}/d:${depth}`);
}

const entryLabel = (e: RegionEntry) => (e.kind === 'region' ? e.region.label : e.group.label);
const entryRegions = (e: RegionEntry) => (e.kind === 'region' ? [e.region] : e.group.regions);

/**
 * Siblings that no directory level separates (a `packages/` folder with eighty packages) are cut
 * into alphabetical ranges, so expanding one level never shows more than `MAX_REGIONS` entries.
 */
function bucket(entries: RegionEntry[], idBase: string): RegionEntry[] {
  if (entries.length <= MAX_REGIONS) return entries;
  const sorted = [...entries].sort((a, b) => entryLabel(a).localeCompare(entryLabel(b)));
  // About √n ranges of about √n entries: 40 siblings become 7 ranges of 6, not 2 of 20.
  const count = Math.min(MAX_REGIONS, Math.ceil(Math.sqrt(sorted.length)));
  const size = Math.ceil(sorted.length / count);
  const ranges: RegionEntry[] = [];
  for (let i = 0; i < sorted.length; i += size) {
    const chunk = sorted.slice(i, i + size);
    if (chunk.length === 1) {
      ranges.push(chunk[0] as RegionEntry);
      continue;
    }
    const id = `${idBase}/r:${i}`;
    const leaves = chunk.flatMap(entryRegions);
    ranges.push({
      kind: 'group',
      group: {
        id,
        label: rangeLabel(
          entryLabel(chunk[0] as RegionEntry),
          entryLabel(chunk.at(-1) as RegionEntry),
        ),
        regions: leaves,
        // Over MAX_REGIONS² siblings a range is itself too wide: cut it the same way.
        children: bucket(chunk, id),
      },
    });
  }
  return ranges;
}

/** `a/b/c/x0 … a/b/c/x9` → `a/b/c/x0 … x9`: the shared directory is said once. */
function rangeLabel(first: string, last: string): string {
  if (first === last) return first;
  let common = 0;
  for (let i = 0; i < Math.min(first.length, last.length) && first[i] === last[i]; i++) {
    if (first[i] === '/') common = i + 1;
  }
  return `${first} … ${last.slice(common)}`;
}

function walkEntries(entries: RegionEntry[], visit: (e: RegionEntry, path: string[]) => void) {
  const go = (list: RegionEntry[], path: string[]) => {
    for (const e of list) {
      visit(e, path);
      if (e.kind === 'group') go(e.group.children, [...path, e.group.id]);
    }
  };
  go(entries, []);
}

/** Every id that can be collapsed: groups and regions. */
export function collapsibleIds(map: RepositoryMap): string[] {
  const ids: string[] = [];
  walkEntries(regionEntries(map), (e) => ids.push(e.kind === 'region' ? e.region.id : e.group.id));
  return ids;
}

export function initialCollapsed(map: RepositoryMap): Set<string> {
  const all = regions(map);
  if (map.topics.length <= COLLAPSE_THRESHOLD || all.length <= 1) return new Set();
  // Regions of one or two topics stay open: collapsing them hides as much as it saves.
  const ids = all.filter((r) => r.topics.length > 2).map((r) => r.id);
  walkEntries(regionEntries(map), (e) => {
    if (e.kind === 'group') ids.push(e.group.id);
  });
  return new Set(ids);
}

function collapsedNode(
  id: string,
  regionId: string,
  label: string,
  topics: MapTopic[],
): VisibleNode {
  const newest = topics
    .map((t) => t.lastChangedAt)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1);
  return {
    kind: 'collapsed',
    id,
    regionId,
    label,
    topicCount: topics.length,
    fileCount: topics.reduce((n, t) => n + t.fileCount + t.testCount, 0),
    markerCount: topics.reduce((n, t) => n + t.markerCount, 0),
    lastChangedAt: newest ?? null,
  };
}

export function visibleGraph(
  map: RepositoryMap,
  collapsed: ReadonlySet<string>,
  focus: string | null = null,
): VisibleGraph {
  // A single region needs no box around everything.
  const boxed = regions(map).length > 1;
  const nodes: VisibleNode[] = [];
  const endpoint = new Map<string, string>(); // topic id → visible node id

  const addRegion = (region: Region) => {
    if (boxed && collapsed.has(region.id)) {
      const id = regionNodeId(region.id);
      nodes.push(collapsedNode(id, region.id, region.label, region.topics));
      for (const t of region.topics) endpoint.set(t.id, id);
      return;
    }
    // A box only pays off with two or more topics; a lone topic carries its region as a caption.
    const box = boxed && region.topics.length > 1;
    const parent = box ? regionNodeId(region.id) : null;
    if (parent) {
      nodes.push({
        kind: 'region',
        id: parent,
        regionId: region.id,
        label: region.label,
        topicCount: region.topics.length,
      });
    }
    for (const t of region.topics) {
      const id = topicNodeId(t.id);
      nodes.push({
        kind: 'topic',
        id,
        parent,
        topic: t,
        caption: boxed && !box ? region.label : null,
      });
      endpoint.set(t.id, id);
    }
  };

  const addEntries = (entries: RegionEntry[]) => {
    for (const entry of entries) {
      if (entry.kind === 'region') {
        addRegion(entry.region);
        continue;
      }
      const { group } = entry;
      if (collapsed.has(group.id)) {
        const id = regionNodeId(group.id);
        const topics = group.regions.flatMap((r) => r.topics);
        nodes.push(collapsedNode(id, group.id, group.label, topics));
        for (const t of topics) endpoint.set(t.id, id);
      } else {
        addEntries(group.children);
      }
    }
  };
  addEntries(regionEntries(map));

  const weights = new Map<string, VisibleEdge>();
  for (const e of map.edges) {
    const source = endpoint.get(e.from);
    const target = endpoint.get(e.to);
    if (!source || !target || source === target) continue;
    const id = `${source}->${target}`;
    const existing = weights.get(id);
    if (existing) existing.weight += e.weight;
    else weights.set(id, { id, source, target, weight: e.weight });
  }
  return { nodes, edges: pruneEdges([...weights.values()], focus) };
}

/**
 * Keeps each node's strongest outgoing edges (and every edge of the focused node). A dense import
 * graph drawn in full is a hairball; the strongest dependencies carry the structure.
 */
export function pruneEdges(edges: VisibleEdge[], focus: string | null): VisibleEdge[] {
  const bySource = new Map<string, VisibleEdge[]>();
  for (const e of edges) {
    const list = bySource.get(e.source);
    if (list) list.push(e);
    else bySource.set(e.source, [e]);
  }
  const keep = new Set<string>();
  for (const list of bySource.values()) {
    list.sort((a, b) => b.weight - a.weight || (a.target < b.target ? -1 : 1));
    for (const e of list.slice(0, EDGES_PER_NODE)) keep.add(e.id);
  }
  return edges.filter(
    (e) => keep.has(e.id) || (focus !== null && (e.source === focus || e.target === focus)),
  );
}

/** Topics directly connected to a topic, split by direction. */
export function neighbours(map: RepositoryMap, topicId: string) {
  const byId = new Map(map.topics.map((t) => [t.id, t]));
  const uses = map.edges
    .filter((e) => e.from === topicId && e.to !== topicId)
    .sort((a, b) => b.weight - a.weight)
    .map((e) => ({ topic: byId.get(e.to), weight: e.weight }))
    .filter((x): x is { topic: MapTopic; weight: number } => !!x.topic);
  const usedBy = map.edges
    .filter((e) => e.to === topicId && e.from !== topicId)
    .sort((a, b) => b.weight - a.weight)
    .map((e) => ({ topic: byId.get(e.from), weight: e.weight }))
    .filter((x): x is { topic: MapTopic; weight: number } => !!x.topic);
  return { uses, usedBy };
}

/** Above this many topics, "expand" opens one level at a time: a full layout would block the page. */
export const EXPAND_ALL_LIMIT = 300;
/**
 * The expand buttons stop above this many visible nodes: ELK needs ~4 s for 300 on the main thread
 * (vercel/next.js), and a frozen tab is worse than one more click on a region.
 */
export const MAX_VISIBLE_NODES = 250;

/** Opens every collapsed group or region that is currently visible (no collapsed ancestor). */
export function expandOneLevel(map: RepositoryMap, collapsed: ReadonlySet<string>): Set<string> {
  const next = new Set(collapsed);
  walkEntries(regionEntries(map), (e, path) => {
    const own = e.kind === 'region' ? e.region.id : e.group.id;
    if (collapsed.has(own) && !path.some((id) => collapsed.has(id))) next.delete(own);
  });
  return next;
}

/** Everything inside a group or region: its topics, and itself plus the groups and regions below. */
export function contentsOf(
  map: RepositoryMap,
  containerId: string,
): { topics: string[]; containers: string[] } {
  const topics: string[] = [];
  const containers: string[] = [];
  walkEntries(regionEntries(map), (e, path) => {
    const own = e.kind === 'region' ? e.region.id : e.group.id;
    if (own !== containerId && !path.includes(containerId)) return;
    containers.push(own);
    if (e.kind === 'region') for (const t of e.region.topics) topics.push(t.id);
  });
  return { topics, containers };
}

/** Ids that must be expanded for a topic to be visible: its group, if any, and its region. */
export function containersOfTopic(map: RepositoryMap, topicId: string): string[] {
  let found: string[] = [];
  walkEntries(regionEntries(map), (e, path) => {
    if (e.kind === 'region' && e.region.topics.some((t) => t.id === topicId)) {
      found = [...path, e.region.id];
    }
  });
  return found;
}

/** Case-insensitive search over names, directories, and summaries; best matches first. */
export function searchTopics(map: RepositoryMap, query: string, limit = 8): MapTopic[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const score = (t: MapTopic) => {
    const name = t.name.toLowerCase();
    if (name.startsWith(q)) return 3;
    if (name.includes(q)) return 2;
    if (t.directory.toLowerCase().includes(q) || (t.summary ?? '').toLowerCase().includes(q))
      return 1;
    return 0;
  };
  return map.topics
    .map((t) => ({ t, s: score(t) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
    .slice(0, limit)
    .map((x) => x.t);
}
