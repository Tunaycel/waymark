import { describe, expect, it } from 'vitest';
import { assignIdentities, jaccard } from './identity.ts';
import { keywordsByTfIdf, tokenize } from './keywords.ts';
import { buildTopics, commonDirectory, type TopicFile, type TopicInput } from './topics.ts';

const file = (path: string, extra: Partial<TopicFile> = {}): TopicFile => ({
  path,
  language: 'TypeScript',
  kind: /\.test\./.test(path) ? 'test' : 'source',
  lines: 10,
  blobSha: null,
  symbols: [],
  externals: [],
  ...extra,
});

/** A small app: auth spread over three directories, a billing area, and unrelated utilities. */
function app(): TopicInput {
  const files = [
    file('src/api/login.ts', { symbols: ['loginHandler'] }),
    file('src/lib/session.ts', { symbols: ['createSession', 'SessionStore'] }),
    file('src/middleware/guard.ts', { symbols: ['requireSession'] }),
    file('src/lib/token.ts', { symbols: ['signToken'] }),
    file('src/billing/invoice.ts', { symbols: ['createInvoice'], externals: ['stripe'] }),
    file('src/billing/webhook.ts', { symbols: ['stripeWebhook'], externals: ['stripe'] }),
    file('src/billing/plans.ts', { symbols: ['PLANS'] }),
    file('src/billing/charge.ts', { externals: ['stripe'] }),
    file('src/lib/format.ts'),
    file('src/lib/dates.ts'),
    file('src/lib/session.test.ts'),
    file('tests/billing/invoice.test.ts'),
  ];
  const e = (from: string, to: string) => ({ from, to });
  const edges = [
    e('src/api/login.ts', 'src/lib/session.ts'),
    e('src/api/login.ts', 'src/lib/token.ts'),
    e('src/middleware/guard.ts', 'src/lib/session.ts'),
    e('src/middleware/guard.ts', 'src/lib/token.ts'),
    e('src/lib/session.ts', 'src/lib/token.ts'),
    e('src/billing/webhook.ts', 'src/billing/invoice.ts'),
    e('src/billing/invoice.ts', 'src/billing/plans.ts'),
    e('src/billing/charge.ts', 'src/billing/invoice.ts'),
    e('src/billing/charge.ts', 'src/billing/plans.ts'),
    e('src/billing/invoice.ts', 'src/lib/format.ts'),
    e('src/lib/session.test.ts', 'src/lib/session.ts'),
    e('tests/billing/invoice.test.ts', 'src/billing/invoice.ts'),
  ];
  return { files, edges, manifests: [{ path: 'package.json', name: 'shop', description: null }] };
}

const topicOf = (map: ReturnType<typeof buildTopics>, path: string) =>
  map.topics.find((t) => t.files.includes(path));

describe('buildTopics', () => {
  it('groups files that import each other across directories', () => {
    const map = buildTopics(app());
    const auth = topicOf(map, 'src/api/login.ts');
    expect(auth?.files).toEqual(
      expect.arrayContaining([
        'src/api/login.ts',
        'src/lib/session.ts',
        'src/lib/token.ts',
        'src/middleware/guard.ts',
      ]),
    );
    const billing = topicOf(map, 'src/billing/webhook.ts');
    expect(billing?.externals[0]).toBe('stripe');
    expect(billing).not.toBe(auth);
  });

  it('attaches tests to the code they import', () => {
    const map = buildTopics(app());
    expect(topicOf(map, 'src/lib/session.test.ts')).toBe(topicOf(map, 'src/lib/session.ts'));
    expect(topicOf(map, 'tests/billing/invoice.test.ts')).toBe(
      topicOf(map, 'src/billing/invoice.ts'),
    );
  });

  it('places every source and test file in exactly one topic', () => {
    const input = app();
    const map = buildTopics(input);
    const placed = map.topics.flatMap((t) => t.files).sort();
    expect(placed).toEqual(input.files.map((f) => f.path).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('builds weighted edges between topics', () => {
    const map = buildTopics(app());
    const billing = topicOf(map, 'src/billing/invoice.ts')?.key;
    const lib = topicOf(map, 'src/lib/format.ts')?.key;
    if (billing !== lib) {
      expect(map.edges).toContainEqual(expect.objectContaining({ from: billing, to: lib }));
    }
  });

  it('is deterministic regardless of input order', () => {
    const input = app();
    const reversed = {
      ...input,
      files: [...input.files].reverse(),
      edges: [...input.edges].reverse(),
    };
    const a = buildTopics(input);
    const b = buildTopics(reversed);
    expect(b.topics).toEqual(a.topics);
    expect(b.edges).toEqual(a.edges);
  });

  it('keeps topics inside package boundaries in a monorepo', () => {
    const files = [
      ...Array.from({ length: 10 }, (_, i) => file(`packages/a/src/a${i}.ts`)),
      ...Array.from({ length: 10 }, (_, i) => file(`packages/b/src/b${i}.ts`)),
    ];
    const edges = files
      .slice(1)
      .map((f, i) => ({ from: (files[i] as TopicFile).path, to: f.path }));
    const map = buildTopics({
      files,
      edges,
      manifests: [
        { path: 'packages/a/package.json', name: '@x/a', description: null },
        { path: 'packages/b/package.json', name: '@x/b', description: null },
      ],
    });
    for (const t of map.topics) {
      expect(new Set(t.files.map((f) => f.split('/')[1])).size).toBe(1);
    }
    // Labels are unique even when two topics would get the same heuristic name.
    const labels = map.topics.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((l) => l.startsWith('A') || l.startsWith('B'))).toBe(true);
  });

  it('splits an oversized community and never produces giant topics', () => {
    // One long chain of 200 files in one directory: one Louvain community at best.
    const files = Array.from({ length: 200 }, (_, i) =>
      file(`src/m${String(i).padStart(3, '0')}.ts`),
    );
    const edges = files
      .slice(1)
      .map((f, i) => ({ from: (files[i] as TopicFile).path, to: f.path }));
    const map = buildTopics({ files, edges, manifests: [] });
    expect(Math.max(...map.topics.map((t) => t.sourceFiles))).toBeLessThanOrEqual(24);
    expect(map.topics.flatMap((t) => t.files)).toHaveLength(200);
  });

  it('collects many tiny sibling directories into one topic', () => {
    const langs = ['de', 'fr', 'tr', 'es', 'it', 'pt'];
    const files = langs.flatMap((l) => [
      file(`conf/locale/${l}/__init__.py`, { language: 'Python' }),
      file(`conf/locale/${l}/formats.py`, { language: 'Python' }),
    ]);
    const edges = langs.map((l) => ({
      from: `conf/locale/${l}/__init__.py`,
      to: `conf/locale/${l}/formats.py`,
    }));
    const others = Array.from({ length: 12 }, (_, i) =>
      file(`core/c${i}.py`, { language: 'Python' }),
    );
    const map = buildTopics({ files: [...files, ...others], edges, manifests: [] });
    const locale = topicOf(map, 'conf/locale/de/formats.py');
    expect(locale?.sourceFiles).toBe(12);
    expect(locale?.directory).toBe('conf/locale');
  });

  it('handles an empty repository and a repository without code', () => {
    expect(buildTopics({ files: [], edges: [], manifests: [] }).topics).toEqual([]);
    const docsOnly = buildTopics({
      files: [file('README.md', { kind: 'docs', language: 'Markdown' })],
      edges: [],
      manifests: [],
    });
    expect(docsOnly.topics).toEqual([]);
  });

  it('stays fast on a large repository', () => {
    const files: TopicFile[] = [];
    const edges: { from: string; to: string }[] = [];
    for (let d = 0; d < 600; d++) {
      for (let f = 0; f < 25; f++) files.push(file(`src/d${d}/f${f}.ts`));
      for (let f = 1; f < 25; f++)
        edges.push({ from: `src/d${d}/f${f}.ts`, to: `src/d${d}/f0.ts` });
      edges.push({ from: `src/d${d}/f1.ts`, to: `src/d${(d + 1) % 600}/f0.ts` });
    }
    for (let t = 0; t < 5_000; t++) files.push(file(`tests/d${t % 600}/t${t}.test.ts`));
    const started = performance.now();
    const map = buildTopics({ files, edges, manifests: [] });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(map.topics.flatMap((t) => t.files)).toHaveLength(files.length);
  });
});

describe('keywords', () => {
  it('tokenizes identifiers and paths, dropping noise words', () => {
    expect(tokenize('createSessionToken')).toEqual(['create', 'session', 'token']);
    expect(tokenize('stripe_webhooks.ts')).toEqual(['stripe', 'webhook']);
    expect(tokenize('src')).toEqual([]);
    expect(tokenize('HTTPServer')).toEqual(['http', 'server']);
  });

  it('prefers words distinctive for a topic over words common to all', () => {
    const [first] = keywordsByTfIdf([
      { paths: ['billing/invoice.ts', 'billing/charge.ts'], symbols: ['createInvoice'] },
      { paths: ['auth/login.ts'], symbols: ['createSession'] },
    ]);
    expect(first?.[0]).toBe('billing');
    expect(first?.at(-1)).toBe('create'); // shared with the other topic: ranked last
  });

  it('commonDirectory finds the deepest directory most files share', () => {
    expect(commonDirectory(['a/b/c/x.ts', 'a/b/c/y.ts', 'a/b/z.ts'])).toBe('a/b/c');
    expect(commonDirectory(['x.ts', 'y.ts'])).toBe('');
  });
});

describe('assignIdentities', () => {
  it('keeps an id when membership changes a little', () => {
    const previous = [{ id: 'auth', files: ['a', 'b', 'c', 'd'] }];
    const ids = assignIdentities([{ key: 'k1', files: ['a', 'b', 'c', 'd', 'e'] }], previous);
    expect(ids.get('k1')).toMatchObject({ id: 'auth', similarity: 0.8 });
  });

  it('gives a genuinely new topic its own id, and each previous id goes to one topic only', () => {
    const previous = [{ id: 'auth', files: ['a', 'b', 'c', 'd'] }];
    const ids = assignIdentities(
      [
        { key: 'k1', files: ['a', 'b', 'c'] },
        { key: 'k2', files: ['a', 'b', 'd'] },
        { key: 'k3', files: ['x', 'y'] },
      ],
      previous,
    );
    expect(ids.get('k1')?.id).toBe('auth'); // tie broken by key
    expect(ids.get('k2')?.id).toBe('k2');
    expect(ids.get('k3')).toMatchObject({ id: 'k3', previous: null });
  });

  it('jaccard', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
});

describe('review regressions', () => {
  /** Shapes that used to take 10–230 s; each must now stay well under a few seconds. */
  const timed = (ms: number, input: TopicInput) => {
    const started = performance.now();
    const map = buildTopics(input);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(ms);
    const placed = map.topics.reduce((n, t) => n + t.files.length, 0);
    expect(placed).toBe(input.files.filter((f) => f.kind === 'source' || f.kind === 'test').length);
    return map;
  };

  it('star: 30k files in one directory all importing one hub (was 227 s)', () => {
    const files = [
      file('icons/index.ts'),
      ...Array.from({ length: 30_000 }, (_, i) => file(`icons/i${i}.ts`)),
    ];
    const edges = files.slice(1).map((f) => ({ from: f.path, to: 'icons/index.ts' }));
    timed(8_000, { files, edges, manifests: [] });
  });

  it('50k files in one flat directory without imports (was 29 s)', () => {
    const files = Array.from({ length: 50_000 }, (_, i) => file(`flat/f${i}.ts`));
    timed(8_000, { files, edges: [], manifests: [] });
  });

  it('30k files 300 directories deep (was 87 s)', () => {
    const deep = Array.from({ length: 300 }, (_, i) => `d${i}`).join('/');
    const files = Array.from({ length: 30_000 }, (_, i) => file(`${deep}/f${i}.ts`));
    timed(8_000, { files, edges: [], manifests: [] });
  });

  it('5,000 packages (was 68–86 s)', () => {
    const files = Array.from({ length: 50_000 }, (_, i) =>
      file(`packages/p${i % 5_000}/src/f${i}.ts`),
    );
    const manifests = Array.from({ length: 5_000 }, (_, p) => ({
      path: `packages/p${p}/package.json`,
      name: `p${p}`,
      description: null,
    }));
    timed(10_000, { files, edges: [], manifests });
  });

  it('50k example files and 30k unattachable tests', () => {
    const files = [
      ...Array.from({ length: 50_000 }, (_, i) => file(`examples/e${i % 400}/f${i}.ts`)),
      ...Array.from({ length: 30_000 }, (_, i) => file(`qa/t${i}.test.ts`)),
    ];
    timed(8_000, { files, edges: [], manifests: [] });
  });

  it('labels stay unique when a numbered fallback would collide', () => {
    const map = buildTopics({
      files: [
        file('x/foo/w.test.ts'),
        file('y/foo/w.test.ts'),
        ...Array.from({ length: 10 }, (_, i) => file(`z/foo-tests-2/a${i}.ts`)),
      ],
      edges: [],
      manifests: [
        { path: 'x/foo/package.json', name: 'a', description: null },
        { path: 'y/foo/package.json', name: 'b', description: null },
        { path: 'z/foo-tests-2/package.json', name: 'c', description: null },
      ],
    });
    const labels = map.topics.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('does not lump unrelated small feature directories into one collection', () => {
    const files: TopicFile[] = [];
    const edges: { from: string; to: string }[] = [];
    for (const area of ['auth', 'billing', 'ui', 'db']) {
      const names = ['a', 'b', 'c'].map((n) => `src/${area}/${area}-${n}.ts`);
      for (const n of names) files.push(file(n));
      edges.push({ from: names[0] as string, to: names[1] as string });
      edges.push({ from: names[1] as string, to: names[2] as string });
    }
    const map = buildTopics({ files, edges, manifests: [] });
    expect(topicOf(map, 'src/auth/auth-a.ts')).not.toBe(topicOf(map, 'src/billing/billing-a.ts'));
  });

  it('assigns unique ids even when a new key equals an id an old topic still holds', () => {
    const previous = [
      { id: 'K', files: ['a', 'b', 'c', 'd'] },
      { id: 'K-2', files: ['p', 'q'] },
      { id: 'K', files: ['dup'] }, // duplicated id in stored data
    ];
    const ids = assignIdentities(
      [
        { key: 'X', files: ['a', 'b', 'c', 'd'] },
        { key: 'Y', files: ['p', 'q'] },
        { key: 'K', files: ['e'] },
      ],
      previous,
    );
    const all = [...ids.values()].map((v) => v.id);
    expect(new Set(all).size).toBe(3);
    expect(ids.get('X')?.id).toBe('K');
    expect(ids.get('Y')?.id).toBe('K-2');
  });
});

describe('buildTopicsIsolated', () => {
  it('returns the same topics as in-process building, across the process boundary', async () => {
    const { buildTopicsIsolated } = await import('./isolated.ts');
    const input = app();
    const isolated = await buildTopicsIsolated(input, { timeoutMs: 30_000 });
    const local = buildTopics(input);
    expect(isolated.topics).toEqual(local.topics);
    expect(isolated.edges).toEqual(local.edges);
    expect(isolated.fileTopic).toEqual(local.fileTopic);
  });
});
