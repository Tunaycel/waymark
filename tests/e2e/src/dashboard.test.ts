import {
  commits,
  type DatabaseHandle,
  listRepositoryCards,
  repositories,
  repositoryMap,
  saveSnapshot,
  topicDetail,
} from '@waymark/db';
import { indexRepository, type SourceFile } from '@waymark/indexer';
import { buildSnapshotTopics } from '@waymark/worker/topics';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, sha } from './helpers.ts';

const silent = pino({ level: 'silent' });
const encoder = new TextEncoder();

async function* memory(files: Record<string, string>): AsyncGenerator<SourceFile> {
  for (const [path, text] of Object.entries(files)) {
    const content = encoder.encode(text);
    yield { path, size: content.byteLength, content };
  }
}

/** Two areas, auth and billing, with one TODO in billing. */
const PROJECT: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop' }),
  'src/auth/login.ts': "import { createSession } from './session';\nexport function login() {}",
  'src/auth/session.ts': "import { signToken } from './token';\nexport function createSession() {}",
  'src/auth/token.ts': 'export function signToken() {}',
  'src/auth/guard.ts':
    "import { createSession } from './session';\nimport { signToken } from './token';",
  'src/auth/password.ts': "import { signToken } from './token';\nexport function hash() {}",
  'src/billing/invoice.ts':
    "import { PLANS } from './plans';\n// TODO: round VAT per line\nexport function invoice() {}",
  'src/billing/plans.ts': 'export const PLANS = [];',
  'src/billing/webhook.ts':
    "import { invoice } from './invoice';\nimport { PLANS } from './plans';",
  'src/billing/charge.ts': "import { invoice } from './invoice';\nimport { PLANS } from './plans';",
  'src/billing/tax.ts': "import { PLANS } from './plans';\nexport function vat() {}",
};

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

describe('dashboard read models → Postgres', () => {
  let handle: DatabaseHandle;
  let repositoryId: string;
  let snapshotId: string;

  beforeEach(async () => {
    handle = await freshDatabase();
    const [repo] = await handle.db
      .insert(repositories)
      .values({
        githubId: 501,
        fullName: 'Octo/Shop',
        defaultBranch: 'main',
        isPrivate: false,
        lastPushAt: daysAgo(0),
      })
      .returning({ id: repositories.id });
    repositoryId = repo?.id as string;
    const index = await indexRepository(memory(PROJECT));
    snapshotId = (await saveSnapshot(handle.db, repositoryId, sha(), index)).snapshotId as string;
    await buildSnapshotTopics(
      { db: handle.db, log: silent, describer: null, monthlyBudgetUsd: 0 },
      snapshotId,
      'Octo/Shop',
    );

    const commit = (at: Date, files: string[], message: string) => ({
      repositoryId,
      sha: sha(),
      branch: 'main',
      message,
      authorName: 'Ada',
      committedAt: at,
      ingestedAt: at,
      url: 'https://example.invalid/c',
      files: { added: [], removed: [], modified: files },
    });
    await handle.db.insert(commits).values([
      commit(daysAgo(0.1), ['src/billing/invoice.ts', 'README.md'], 'fix: invoice totals\n\nbody'),
      commit(daysAgo(3), ['src/auth/login.ts'], 'feat: login'),
      // Outside the 30-day window: never counted.
      commit(daysAgo(40), ['src/auth/token.ts', 'src/billing/tax.ts'], 'old work'),
      // A huge commit: thousands of paths, almost none of them indexed.
      commit(
        daysAgo(1),
        [...Array.from({ length: 3_000 }, (_, i) => `vendor/lib${i}.js`), 'src/billing/plans.ts'],
        'chore: vendor',
      ),
    ]);
  });
  afterEach(async () => {
    await handle.close();
  });

  it('finds a repository case-insensitively and marks recently changed topics', async () => {
    const map = await repositoryMap(handle.db, 'octo/SHOP');
    expect(map?.repository.fullName).toBe('Octo/Shop');
    const billing = map?.topics.find((t) => t.directory.includes('billing'));
    const auth = map?.topics.find((t) => t.directory.includes('auth'));
    expect(billing).toMatchObject({ commits30d: 2, markerCount: 1 });
    expect(auth).toMatchObject({ commits30d: 1, markerCount: 0 });
    // Newest touching commit wins.
    expect(Date.now() - Date.parse(billing?.lastChangedAt ?? '')).toBeLessThan(86_400_000);
    expect(map?.edges.length).toBeGreaterThanOrEqual(0);
    expect(await repositoryMap(handle.db, 'octo/nope')).toBeNull();
  });

  it('prefers the latest snapshot that has topics over a newer one still being built', async () => {
    const index = await indexRepository(memory({ ...PROJECT, 'src/new.ts': 'export {}' }));
    const newer = await saveSnapshot(handle.db, repositoryId, sha(), index);
    expect(newer.snapshotId).not.toBe(snapshotId);
    const map = await repositoryMap(handle.db, 'Octo/Shop');
    expect(map?.snapshot.id).toBe(snapshotId);
    expect(map?.topics.length).toBe(2);
  });

  it('summarises each repository for the project list', async () => {
    const [card] = await listRepositoryCards(handle.db);
    expect(card).toMatchObject({ fullName: 'Octo/Shop', commits7d: 3 });
    expect(card?.snapshot).toMatchObject({ id: snapshotId, topicCount: 2, markerCount: 1 });
    expect(card?.activeTopics).toHaveLength(2);

    // The overview's stars: every topic (fewer than the cap), glowing where commits touched them.
    const stars = card?.constellation.stars ?? [];
    expect(stars).toHaveLength(2);
    expect(card?.constellation.hidden).toBe(0);
    expect(stars.every((s) => s.lastChangedAt !== null)).toBe(true);
    for (const [from, to] of card?.constellation.links ?? []) {
      expect(stars[from]).toBeDefined();
      expect(stars[to]).toBeDefined();
      expect(from).not.toBe(to);
    }
    // Only what the sky draws leaves the server: no topic names or ids.
    expect(Object.keys(stars[0] ?? {}).sort()).toEqual(['lastChangedAt', 'lines']);
  });

  it('returns a topic panel with its files, TODOs, and recent commits only', async () => {
    const map = await repositoryMap(handle.db, 'Octo/Shop');
    const billing = map?.topics.find((t) => t.directory.includes('billing'));
    const detail = await topicDetail(handle.db, repositoryId, snapshotId, billing?.id as string);
    expect(detail?.fileCount).toBe(5);
    expect(detail?.files.map((f) => f.path)).toContain('src/billing/invoice.ts');
    expect(detail?.markers.map((m) => m.text)).toEqual(['round VAT per line']);
    expect(detail?.commits.map((c) => c.message)).toEqual(['fix: invoice totals', 'chore: vendor']);
  });

  it('refuses a snapshot that belongs to another repository', async () => {
    const [other] = await handle.db
      .insert(repositories)
      .values({ githubId: 502, fullName: 'octo/other', defaultBranch: 'main', isPrivate: true })
      .returning({ id: repositories.id });
    const map = await repositoryMap(handle.db, 'Octo/Shop');
    const topic = map?.topics[0]?.id as string;
    expect(await topicDetail(handle.db, other?.id as string, snapshotId, topic)).toBeNull();
  });
});
