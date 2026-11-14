import { createHash } from 'node:crypto';
import type { FileEdge, IndexedFile, Manifest } from '@waymark/indexer';
import { keywordsByTfIdf, labelFrom } from './keywords.ts';
import { louvain } from './louvain.ts';

export type TopicFile = Pick<
  IndexedFile,
  'path' | 'language' | 'kind' | 'lines' | 'blobSha' | 'symbols' | 'externals'
>;

export interface TopicInput {
  files: TopicFile[];
  edges: FileEdge[];
  manifests: Pick<Manifest, 'path' | 'name' | 'description'>[];
}

export interface Topic {
  /** Content key: hash of the member paths. Changes whenever membership changes. */
  key: string;
  /** Package root the topic belongs to (`''` = repository root). */
  package: string;
  /** Deepest directory shared by most of its source files. */
  directory: string;
  /** Member paths, sorted: source files first, then the tests attached to them. */
  files: string[];
  sourceFiles: number;
  testFiles: number;
  lines: number;
  languages: Record<string, number>;
  keywords: string[];
  /** Heuristic name, used until (or instead of) an AI description. */
  label: string;
  /** Most telling exported names (at most 40). */
  symbols: string[];
  /** External packages used by its files, most used first (at most 10). */
  externals: string[];
}

export interface TopicEdge {
  from: string;
  to: string;
  /** Number of file-level imports from one topic into the other. */
  weight: number;
}

export interface TopicMap {
  topics: Topic[];
  edges: TopicEdge[];
  /** Member path → topic key. */
  fileTopic: Map<string, string>;
}

export const TOPIC_LIMITS = {
  /** Smaller communities are merged into their closest neighbour. */
  minSize: 5,
  /** Larger ones are split: a map node with hundreds of files says nothing. */
  maxSize: 24,
  /** Packages this small are one topic. */
  smallPackage: 8,
};

const PACKAGE_MANIFESTS = /(^|\/)(package\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/;
const NOT_A_PACKAGE = /(^|\/)(fixtures?|__fixtures__|testdata|test-data|__mocks__)(\/|$)/;

/**
 * Directories of example apps, fixtures, and benchmarks: often hundreds of small self-contained
 * projects (next.js ships ~400 examples). Each such directory becomes one collection topic instead
 * of being clustered, which would turn every example into its own map node.
 */
const AUXILIARY =
  /^(.*?(?:^|\/)(?:examples?|samples?|demos?|fixtures?|__fixtures__|testdata|test-data|bench|benchmarks?|playgrounds?))(?:\/|$)/;

/** `examples/blog/app.ts` → `examples`; `packages/x/fixtures/a.ts` → `packages/x/fixtures`. */
const auxiliaryRoot = (path: string) => AUXILIARY.exec(path)?.[1] ?? null;
const TEST_SEGMENTS = /(^|\/)(__tests__|tests?|spec|e2e)(\/|$)/g;

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Appends in place. (Copying the array on every insert made grouping quadratic.) */
function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Directory levels considered when comparing locations; deeper levels don't change a topic. */
const MAX_DEPTH = 32;
const directoryParts = (path: string) =>
  dirname(path).split('/').filter(Boolean).slice(0, MAX_DEPTH);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Groups a repository's files into topics: communities of files that import each other (Louvain),
 * kept within package boundaries, with isolated files attached by directory, tiny communities
 * merged, oversized ones split, and tests attached to the code they exercise.
 */
export function buildTopics(input: TopicInput): TopicMap {
  const packages = input.manifests
    .map((m) => m.path)
    .filter((p) => PACKAGE_MANIFESTS.test(p))
    .map(dirname)
    .filter((d) => !NOT_A_PACKAGE.test(d) && auxiliaryRoot(`${d}/x`) === null)
    .sort((a, b) => b.length - a.length); // deepest first
  const packageSet = new Set(packages);
  const packageOfDir = new Map<string, string>();
  const packageOf = (path: string): string => {
    const dir = dirname(path);
    const cached = packageOfDir.get(dir);
    if (cached !== undefined) return cached;
    // Walk up the directory's ancestors instead of scanning every package for every file.
    let found = '';
    let current = dir;
    for (let depth = 0; current !== '' && depth < 256; depth++) {
      if (packageSet.has(current)) {
        found = current;
        break;
      }
      current = dirname(current);
    }
    packageOfDir.set(dir, found);
    return found;
  };

  const byPath = new Map(input.files.map((f) => [f.path, f]));
  const sources = input.files.filter((f) => f.kind === 'source').map((f) => f.path);
  sources.sort(compare);
  const tests = input.files.filter((f) => f.kind === 'test').map((f) => f.path);
  tests.sort(compare);

  // Undirected weights between source files; cross-package edges don't shape communities.
  const weights = new Map<string, Map<string, number>>();
  const link = (a: string, b: string) => {
    const m = weights.get(a) ?? new Map<string, number>();
    m.set(b, (m.get(b) ?? 0) + 1);
    weights.set(a, m);
  };
  const isSource = new Set(sources);
  for (const e of input.edges) {
    if (e.from === e.to || !isSource.has(e.from) || !isSource.has(e.to)) continue;
    if (packageOf(e.from) !== packageOf(e.to)) continue;
    link(e.from, e.to);
    link(e.to, e.from);
  }

  const groups = new Map<string, string[]>();
  const auxiliary = new Map<string, string[]>();
  for (const path of sources) {
    const aux = auxiliaryRoot(path);
    if (aux !== null) {
      append(auxiliary, aux, path);
      continue;
    }
    const pkg = packageOf(path);
    const list = groups.get(pkg) ?? [];
    list.push(path);
    groups.set(pkg, list);
  }

  const communities: { package: string; files: string[] }[] = [];
  for (const [pkg, files] of [...groups.entries()].sort(([a], [b]) => compare(a, b))) {
    for (const members of partitionPackage(files, weights)) {
      communities.push({ package: pkg, files: members });
    }
  }
  for (const [root, files] of [...auxiliary.entries()].sort(([a], [b]) => compare(a, b))) {
    communities.push({ package: packageOf(root), files: files.sort(compare) });
  }

  // Tests join the topic whose code they import most; otherwise the topic of their directory.
  const sourceTopic = new Map<string, number>();
  communities.forEach((c, i) => {
    for (const f of c.files) sourceTopic.set(f, i);
  });
  const testsOf = communities.map(() => [] as string[]);
  const looseTests = new Map<string, string[]>();
  const importsFrom = new Map<string, string[]>();
  for (const e of input.edges) {
    const list = importsFrom.get(e.from) ?? [];
    list.push(e.to);
    importsFrom.set(e.from, list);
  }
  const directoryIndex = indexDirectories(communities);
  for (const test of tests) {
    const votes = new Map<number, number>();
    // Only code in the test's own package counts: integration tests that import several packages
    // belong to the package they live in.
    const ownPackage = packageOf(test);
    for (const target of importsFrom.get(test) ?? []) {
      const t = sourceTopic.get(target);
      if (t !== undefined && communities[t]?.package === ownPackage) {
        votes.set(t, (votes.get(t) ?? 0) + 1);
      }
    }
    let chosen = pickMax(votes);
    if (chosen === undefined) chosen = topicByDirectory(test, packageOf(test), directoryIndex);
    if (chosen !== undefined) (testsOf[chosen] as string[]).push(test);
    else {
      const pkg = packageOf(test);
      append(looseTests, pkg, test);
    }
  }
  for (const [pkg, files] of [...looseTests.entries()].sort(([a], [b]) => compare(a, b))) {
    communities.push({ package: pkg, files: [] });
    testsOf.push(files);
  }

  const keywords = keywordsByTfIdf(
    communities.map((c, i) => {
      const all = [...c.files, ...(testsOf[i] as string[])];
      return {
        paths: all.map((p) => relativeTo(c.package, p)),
        symbols: c.files.flatMap((p) => byPath.get(p)?.symbols ?? []),
      };
    }),
  );

  const sourcesInPackage = new Map<string, number>();
  for (const c of communities) {
    sourcesInPackage.set(c.package, (sourcesInPackage.get(c.package) ?? 0) + c.files.length);
  }

  const topics: Topic[] = communities.map((c, i) => {
    const testFiles = testsOf[i] as string[];
    const files = [...c.files, ...testFiles];
    const languages: Record<string, number> = {};
    let lines = 0;
    const externals = new Map<string, number>();
    for (const path of files) {
      const f = byPath.get(path);
      if (!f) continue;
      if (f.language && f.lines !== null) {
        languages[f.language] = (languages[f.language] ?? 0) + f.lines;
        lines += f.lines;
      }
      for (const ext of f.externals) externals.set(ext, (externals.get(ext) ?? 0) + 1);
    }
    const directory = commonDirectory(c.files.length > 0 ? c.files : testFiles);
    const words = keywords[i] ?? [];
    return {
      key: topicKey(files),
      package: c.package,
      directory,
      files,
      sourceFiles: c.files.length,
      testFiles: testFiles.length,
      lines,
      languages,
      keywords: words,
      label: heuristicLabel(c, words, directory, sourcesInPackage.get(c.package) ?? 0, testFiles),
      symbols: c.files.flatMap((p) => byPath.get(p)?.symbols ?? []).slice(0, 40),
      externals: [...externals.entries()]
        .sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
        .slice(0, 10)
        .map(([name]) => name),
    };
  });

  disambiguateLabels(topics);

  const fileTopic = new Map<string, string>();
  for (const t of topics) for (const f of t.files) fileTopic.set(f, t.key);

  const edgeWeights = new Map<string, TopicEdge>();
  for (const e of input.edges) {
    const from = fileTopic.get(e.from);
    const to = fileTopic.get(e.to);
    if (!from || !to || from === to) continue;
    const id = `${from}>${to}`;
    const existing = edgeWeights.get(id) ?? { from, to, weight: 0 };
    existing.weight++;
    edgeWeights.set(id, existing);
  }

  return {
    topics,
    edges: [...edgeWeights.values()].sort(
      (a, b) => b.weight - a.weight || compare(a.from, b.from) || compare(a.to, b.to),
    ),
    fileTopic,
  };
}

/** Communities for the source files of one package. */
function partitionPackage(files: string[], weights: Map<string, Map<string, number>>): string[][] {
  if (files.length <= TOPIC_LIMITS.smallPackage) return [files];

  let groups = cluster(files, weights, 1);
  groups = attachIsolated(groups, weights);
  groups = mergeSmall(groups, weights);
  const { collections, rest } = collectSiblings(groups);
  groups = [...rest.flatMap((g) => splitLarge(g, weights, 0)), ...collections];
  return groups.map((g) => [...g].sort(compare)).sort((a, b) => compare(a[0] ?? '', b[0] ?? ''));
}

/**
 * Small groups that still stand alone after merging, living in sibling directories of one parent
 * (`conf/locale/de`, `conf/locale/fr`, … or `plugins/a`, `plugins/b`), become one collection topic.
 * They are many instances of one idea; a map node per instance would only add noise. Collections
 * are not split by size: they are homogeneous, so one node reads fine however many files it has.
 */
function collectSiblings(groups: string[][]): { collections: string[][]; rest: string[][] } {
  const byParent = new Map<string, number[]>();
  groups.forEach((g, i) => {
    if (g.length >= TOPIC_LIMITS.minSize) return;
    const dir = commonDirectory(g);
    if (dir === '' || g.some((f) => dirname(f) !== dir && !dirname(f).startsWith(`${dir}/`)))
      return;
    // Same parent and same file names: `conf/locale/de` and `conf/locale/fr` qualify,
    // `src/auth` and `src/billing` (different files) do not.
    const shape = [...new Set(g.map((f) => f.slice(dir.length + 1)))].sort().join('|');
    append(byParent, `${dirname(dir)}\u0000${shape}`, i);
  });
  const used = new Set<number>();
  const collections: string[][] = [];
  for (const members of byParent.values()) {
    if (members.length < 3) continue; // two siblings are not a pattern
    collections.push(members.flatMap((i) => groups[i] as string[]));
    for (const i of members) used.add(i);
  }
  return { collections, rest: groups.filter((_, i) => !used.has(i)) };
}

function cluster(
  files: string[],
  weights: Map<string, Map<string, number>>,
  resolution: number,
): string[][] {
  const index = new Map(files.map((f, i) => [f, i]));
  const edges: [number, number, number][] = [];
  files.forEach((f, i) => {
    for (const [other, w] of weights.get(f) ?? []) {
      const j = index.get(other);
      if (j !== undefined && i < j) edges.push([i, j, w]);
    }
  });
  const membership = louvain(files.length, edges, { resolution });
  const groups = new Map<number, string[]>();
  membership.forEach((c, i) => {
    append(groups, c, files[i] as string);
  });
  return [...groups.values()];
}

const degreeWithin = (
  file: string,
  members: Set<string>,
  weights: Map<string, Map<string, number>>,
) => {
  let sum = 0;
  for (const [other, w] of weights.get(file) ?? []) if (members.has(other)) sum += w;
  return sum;
};

/** Files with no imports either way join the community that dominates their directory. */
function attachIsolated(groups: string[][], weights: Map<string, Map<string, number>>): string[][] {
  const all = new Set(groups.flat());
  const isolated = new Set([...all].filter((f) => degreeWithin(f, all, weights) === 0));
  const kept = groups.map((g) => g.filter((f) => !isolated.has(f))).filter((g) => g.length > 0);

  const dirVotes = new Map<string, Map<number, number>>();
  kept.forEach((g, i) => {
    for (const f of g) {
      const votes = dirVotes.get(dirname(f)) ?? new Map<number, number>();
      votes.set(i, (votes.get(i) ?? 0) + 1);
      dirVotes.set(dirname(f), votes);
    }
  });
  const byDirectory = new Map<string, string[]>();
  for (const f of [...isolated].sort(compare)) {
    const target = pickMax(dirVotes.get(dirname(f)) ?? new Map());
    if (target !== undefined) (kept[target] as string[]).push(f);
    else append(byDirectory, dirname(f), f);
  }
  return [...kept, ...byDirectory.values()];
}

/** Communities below the minimum size join the neighbour they import most, else their directory's. */
function mergeSmall(groups: string[][], weights: Map<string, Map<string, number>>): string[][] {
  let current = groups.map((g) => [...g]);
  for (let pass = 0; pass < 8; pass++) {
    const owner = new Map<string, number>();
    current.forEach((g, i) => {
      for (const f of g) owner.set(f, i);
    });
    const order = current
      .map((_, i) => i)
      .filter((i) => (current[i] as string[]).length < TOPIC_LIMITS.minSize)
      .sort((a, b) => (current[a] as string[]).length - (current[b] as string[]).length || a - b);
    if (order.length === 0 || current.length === 1) break;

    // Per directory, the group with the most files there (ties: lowest index). O(files).
    const counts = new Map<string, Map<number, number>>();
    current.forEach((g, j) => {
      for (const f of g) {
        const dir = dirname(f);
        const perGroup = counts.get(dir) ?? new Map<number, number>();
        perGroup.set(j, (perGroup.get(j) ?? 0) + 1);
        counts.set(dir, perGroup);
      }
    });
    const largestInDirectory = new Map<string, number>();
    for (const [dir, perGroup] of counts) {
      const best = pickMax(perGroup);
      if (best !== undefined) largestInDirectory.set(dir, best);
    }

    let changed = false;
    const merged = new Set<number>();
    for (const i of order) {
      if (merged.has(i)) continue;
      const group = current[i] as string[];
      const votes = new Map<number, number>();
      for (const f of group) {
        for (const [other, w] of weights.get(f) ?? []) {
          const j = owner.get(other);
          if (j !== undefined && j !== i && !merged.has(j)) votes.set(j, (votes.get(j) ?? 0) + w);
        }
      }
      let target = pickMax(votes);
      if (target === undefined) {
        const candidate = largestInDirectory.get(dirname(group[0] as string));
        if (candidate !== undefined && candidate !== i && !merged.has(candidate)) {
          target = candidate;
        }
      }
      if (target === undefined) continue;
      (current[target] as string[]).push(...group);
      for (const f of group) owner.set(f, target);
      current[i] = [];
      merged.add(i);
      changed = true;
    }
    current = current.filter((g) => g.length > 0);
    if (!changed) break;
  }
  return current;
}

/** Splits an oversized community: finer clustering first, then directories, then evenly. */
function splitLarge(
  group: string[],
  weights: Map<string, Map<string, number>>,
  depth: number,
): string[][] {
  if (group.length <= TOPIC_LIMITS.maxSize) return [group];
  if (depth < 2) {
    const parts = cluster(group, weights, depth === 0 ? 3 : 8);
    const meaningful = mergeSmall(attachIsolated(parts, weights), weights);
    if (meaningful.length > 1) return meaningful.flatMap((p) => splitLarge(p, weights, depth + 1));
  }
  // By the next directory level below what the files share.
  const base = commonDirectory(group);
  const byDir = new Map<string, string[]>();
  for (const f of group) {
    const rest = base === '' ? f : f.slice(base.length + 1);
    const key = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : '';
    append(byDir, key, f);
  }
  if (byDir.size > 1) {
    return [...byDir.values()].flatMap((p) => splitLarge(p, weights, depth + 1));
  }
  // One flat directory: alphabetical chunks.
  const sorted = [...group].sort(compare);
  const chunks = Math.ceil(sorted.length / TOPIC_LIMITS.maxSize);
  const size = Math.ceil(sorted.length / chunks);
  return Array.from({ length: chunks }, (_, i) => sorted.slice(i * size, (i + 1) * size));
}

type DirectoryIndex = Map<string, Map<number, number>>;

/**
 * package + directory suffix → community → file count. Every suffix of a source directory is
 * indexed (`src/auth` also as `auth`), so `tests/auth/test_x.py` finds `src/auth`.
 */
function indexDirectories(communities: { package: string; files: string[] }[]): DirectoryIndex {
  const index: DirectoryIndex = new Map();
  communities.forEach((c, i) => {
    for (const f of c.files) {
      const parts = directoryParts(f);
      for (let k = 0; k < parts.length; k++) {
        const key = `${c.package}\u0000${parts.slice(k).join('/')}`;
        const votes = index.get(key) ?? new Map<number, number>();
        votes.set(i, (votes.get(i) ?? 0) + 1);
        index.set(key, votes);
      }
    }
  });
  return index;
}

function topicByDirectory(test: string, pkg: string, index: DirectoryIndex): number | undefined {
  // `src/auth/__tests__/x.test.ts` → `src/auth`; `tests/auth/test_x.py` → `auth`
  const dir = dirname(test).replace(TEST_SEGMENTS, '/').split('/').filter(Boolean).join('/');
  if (dir === '') return undefined;
  return pickMax(index.get(`${pkg}\u0000${dir}`) ?? new Map());
}

/** Highest count; ties go to the lowest key. */
function pickMax(votes: Map<number, number>): number | undefined {
  let best: number | undefined;
  let bestCount = 0;
  for (const [k, count] of votes) {
    if (count > bestCount || (count === bestCount && best !== undefined && k < best)) {
      best = k;
      bestCount = count;
    }
  }
  return best;
}

/** Deepest directory shared by at least 60% of the files. */
export function commonDirectory(files: string[]): string {
  if (files.length === 0) return '';
  const counts = new Map<string, number>();
  for (const f of files) {
    let prefix = '';
    for (const part of directoryParts(f)) {
      prefix = prefix === '' ? part : `${prefix}/${part}`;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  let best = '';
  for (const [dir, count] of counts) {
    if (count / files.length >= 0.6 && dir.length > best.length) best = dir;
  }
  return best;
}

const GENERIC_DIRECTORIES = new Set(['src', 'lib', 'app', 'source', 'pkg', 'internal', 'cmd', '']);

/**
 * A readable name without AI: the package's own name when the topic is (nearly) the whole package,
 * else its distinctive directory, else its strongest keywords.
 */
function heuristicLabel(
  c: { package: string; files: string[] },
  keywords: string[],
  directory: string,
  packageSources: number,
  tests: string[],
): string {
  const title = (s: string) =>
    s
      .split(/[-_.\s]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  const packageName = title(lastSegment(c.package));
  if (c.files.length === 0)
    return packageName ? `${packageName} Tests` : tests.length ? 'Tests' : 'Root';
  if (packageName && c.files.length >= 0.8 * packageSources) return packageName;

  const relative =
    c.package && directory.startsWith(c.package) ? directory.slice(c.package.length) : directory;
  const segment = lastSegment(relative).toLowerCase();
  if (!GENERIC_DIRECTORIES.has(segment)) {
    const extra = keywords.find((k) => !segment.includes(k));
    return extra ? `${title(segment)} · ${title(extra)}` : title(segment);
  }
  return labelFrom(keywords, packageName || 'Root');
}

/** Two topics with the same label get a distinguishing keyword, or a number as a last resort. */
function disambiguateLabels(topics: Topic[]): void {
  const groups = new Map<string, Topic[]>();
  for (const t of topics) append(groups, t.label, t);
  const taken = new Set(topics.map((t) => t.label));
  for (const [label, same] of groups) {
    if (same.length < 2) continue;
    same.forEach((t, i) => {
      const word = t.keywords.find((k) => !label.toLowerCase().includes(k));
      let candidate = word ? `${label} · ${word.charAt(0).toUpperCase()}${word.slice(1)}` : '';
      for (let n = i + 1; !candidate || taken.has(candidate); n++) candidate = `${label} ${n}`;
      taken.add(candidate);
      t.label = candidate;
    });
  }
}

function relativeTo(pkg: string, path: string): string {
  return pkg !== '' && path.startsWith(`${pkg}/`) ? path.slice(pkg.length + 1) : path;
}

function lastSegment(path: string): string {
  const segment = path.slice(path.lastIndexOf('/') + 1);
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

function topicKey(files: string[]): string {
  return createHash('sha1')
    .update([...files].sort(compare).join('\n'))
    .digest('hex')
    .slice(0, 12);
}
