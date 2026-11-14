import {
  type DatabaseHandle,
  llmUsage,
  repositories,
  repositoryTopics,
  saveSnapshot,
  snapshotFiles,
  snapshotTopicEdges,
  snapshotTopics,
} from '@waymark/db';
import { indexRepository, type SourceFile } from '@waymark/indexer';
import type { Describer, TopicBrief } from '@waymark/mapper';
import { buildSnapshotTopics } from '@waymark/worker/topics';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from './helpers.ts';

const silent = pino({ level: 'silent' });
const encoder = new TextEncoder();

async function* memory(files: Record<string, string>): AsyncGenerator<SourceFile> {
  for (const [path, text] of Object.entries(files)) {
    const content = encoder.encode(text);
    yield { path, size: content.byteLength, content };
  }
}

/** Two clear areas: auth (5 files) and billing (5 files), plus a test. Above the one-topic size. */
const PROJECT: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shop', description: 'An online shop' }),
  'README.md': '# Shop\n\nSells things online.',
  'src/auth/login.ts': "import { createSession } from './session';\nexport function login() {}",
  'src/auth/session.ts': "import { signToken } from './token';\nexport function createSession() {}",
  'src/auth/token.ts': 'export function signToken() {}',
  'src/auth/guard.ts':
    "import { createSession } from './session';\nimport { signToken } from './token';",
  'src/billing/invoice.ts':
    "import Stripe from 'stripe';\nimport { PLANS } from './plans';\nexport function createInvoice() {}",
  'src/billing/plans.ts': 'export const PLANS = [];',
  'src/billing/webhook.ts':
    "import { createInvoice } from './invoice';\nimport { PLANS } from './plans';",
  'src/billing/charge.ts':
    "import { createInvoice } from './invoice';\nimport { PLANS } from './plans';",
  'src/auth/password.ts': "import { signToken } from './token';\nexport function hashPassword() {}",
  'src/billing/tax.ts': "import { PLANS } from './plans';\nexport function vat() {}",
  'src/auth/session.test.ts': "import { createSession } from './session';",
};

/** A describer that names each topic after its first file and counts what it was asked. */
function fakeDescriber(costPerCall = 0.001) {
  const asked: TopicBrief[][] = [];
  const describer: Describer = {
    provider: 'claude',
    model: 'fake-model',
    estimateCostUsd: () => costPerCall * 2,
    describe: async (_repo, briefs) => {
      asked.push(briefs);
      return {
        descriptions: briefs.map((b) => ({
          id: b.id,
          name: b.files.some((f) => f.includes('billing')) ? 'Billing' : 'Authentication',
          summary: `Handles ${b.files.length} files.`,
          role: 'feature' as const,
        })),
        usage: { inputTokens: 1_000, outputTokens: 100, costUsd: costPerCall },
      };
    },
  };
  return { describer, asked };
}

describe('topic building → Postgres', () => {
  let handle: DatabaseHandle;
  let repositoryId: string;

  beforeEach(async () => {
    handle = await freshDatabase();
    const [repo] = await handle.db
      .insert(repositories)
      .values({ githubId: 77, fullName: 'octo/shop', defaultBranch: 'main', isPrivate: false })
      .returning({ id: repositories.id });
    repositoryId = repo?.id as string;
  });
  afterEach(async () => {
    await handle.close();
  });

  async function snapshot(sha: string, files: Record<string, string>) {
    const index = await indexRepository(memory(files));
    const saved = await saveSnapshot(handle.db, repositoryId, sha, index);
    return saved.snapshotId as string;
  }
  const deps = (describer: Describer | null, monthlyBudgetUsd = 2) => ({
    db: handle.db,
    log: silent,
    describer,
    monthlyBudgetUsd,
  });
  const topicsOf = (snapshotId: string) =>
    handle.db
      .select()
      .from(snapshotTopics)
      .where(eq(snapshotTopics.snapshotId, snapshotId))
      .orderBy(asc(snapshotTopics.name));

  it('stores named topics, their edges, file labels, and what the names cost', async () => {
    const id = await snapshot('a'.repeat(40), PROJECT);
    const { describer } = fakeDescriber();
    const outcome = await buildSnapshotTopics(deps(describer), id, 'octo/shop');

    expect(outcome).toMatchObject({ topics: 2, described: 2, reused: 0, heuristic: 0 });
    const topics = await topicsOf(id);
    expect(topics.map((t) => [t.name, t.source, t.fileCount])).toEqual([
      ['Authentication', 'ai', 5],
      ['Billing', 'ai', 5],
    ]);
    expect(topics.find((t) => t.name === 'Billing')?.externals).toEqual(['stripe']);
    expect(topics.find((t) => t.name === 'Authentication')?.testCount).toBe(1);

    const unlabeled = await handle.db
      .select({ path: snapshotFiles.path, kind: snapshotFiles.kind })
      .from(snapshotFiles)
      .where(isNull(snapshotFiles.topicId));
    expect(unlabeled.every((f) => f.kind !== 'source' && f.kind !== 'test')).toBe(true);

    const usage = await handle.db.select().from(llmUsage);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ provider: 'claude', model: 'fake-model', costUsd: 0.001 });
  });

  it('keeps topic ids and reuses descriptions when a later commit changes a little', async () => {
    const first = await snapshot('a'.repeat(40), PROJECT);
    const { describer, asked } = fakeDescriber();
    await buildSnapshotTopics(deps(describer), first, 'octo/shop');
    const before = await topicsOf(first);

    // One file edited, one file added: the same two topics, nothing worth paying for again.
    const second = await snapshot('b'.repeat(40), {
      ...PROJECT,
      'src/auth/token.ts': 'export function signToken() { return 1; }',
      'src/billing/refund.ts': "import { createInvoice } from './invoice';",
    });
    const outcome = await buildSnapshotTopics(deps(describer), second, 'octo/shop');
    const after = await topicsOf(second);

    expect(outcome).toMatchObject({ described: 0, reused: 2 });
    expect(asked).toHaveLength(1); // only the first build called the model
    expect(after.map((t) => t.topicId).sort()).toEqual(before.map((t) => t.topicId).sort());
    expect(after.find((t) => t.name === 'Billing')?.fileCount).toBe(6);
  });

  it('describes a topic again once most of its files changed', async () => {
    const first = await snapshot('a'.repeat(40), PROJECT);
    const { describer, asked } = fakeDescriber();
    await buildSnapshotTopics(deps(describer), first, 'octo/shop');

    const rewritten = Object.fromEntries(
      Object.entries(PROJECT).map(([p, text]) => [
        p,
        p.includes('billing') ? `${text}\n// v2` : text,
      ]),
    );
    const second = await snapshot('b'.repeat(40), rewritten);
    const outcome = await buildSnapshotTopics(deps(describer), second, 'octo/shop');
    expect(outcome).toMatchObject({ described: 1, reused: 1 });
    expect(asked[1]?.map((b) => b.files.some((f) => f.includes('billing')))).toEqual([true]);
  });

  it('falls back to heuristic names when the monthly budget is spent, then catches up', async () => {
    await handle.db.insert(llmUsage).values({
      provider: 'claude',
      model: 'fake-model',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 1.999, // spent earlier this month
    });
    const id = await snapshot('a'.repeat(40), PROJECT);
    const { describer, asked } = fakeDescriber();
    const outcome = await buildSnapshotTopics(deps(describer, 2), id, 'octo/shop');

    expect(outcome).toMatchObject({ described: 0, heuristic: 2, stoppedBy: 'budget' });
    expect(asked).toHaveLength(0);
    const topics = await topicsOf(id);
    expect(topics.every((t) => t.source === 'heuristic' && t.summary === null)).toBe(true);

    // Next build with room in the budget (e.g. next month, or a raised cap) names them.
    const later = await snapshot('b'.repeat(40), PROJECT);
    const retry = await buildSnapshotTopics(deps(describer, 5), later, 'octo/shop');
    expect(retry).toMatchObject({ described: 2, stoppedBy: null });
  });

  it('works without any AI provider', async () => {
    const id = await snapshot('a'.repeat(40), PROJECT);
    const outcome = await buildSnapshotTopics(deps(null), id, 'octo/shop');
    expect(outcome).toMatchObject({ topics: 2, described: 0, heuristic: 2 });
    const topics = await topicsOf(id);
    // Heuristic names lead with the topic's directory.
    expect(topics.map((t) => t.name.split(' ')[0]).sort()).toEqual(['Auth', 'Billing']);
    expect(await handle.db.select().from(llmUsage)).toHaveLength(0);
  });

  it('is idempotent: rebuilding a snapshot replaces its topics', async () => {
    const id = await snapshot('a'.repeat(40), PROJECT);
    await buildSnapshotTopics(deps(null), id, 'octo/shop');
    await buildSnapshotTopics(deps(null), id, 'octo/shop');
    expect(await topicsOf(id)).toHaveLength(2);
    const edges = await handle.db
      .select()
      .from(snapshotTopicEdges)
      .where(eq(snapshotTopicEdges.snapshotId, id));
    expect(new Set(edges.map((e) => `${e.fromTopic}>${e.toTopic}`)).size).toBe(edges.length);
    expect(await handle.db.select().from(repositoryTopics)).toHaveLength(2);
  });
});

describe('topic building under concurrency and old data', () => {
  let handle: DatabaseHandle;
  beforeEach(async () => {
    handle = await freshDatabase();
  });
  afterEach(async () => {
    await handle.close();
  });

  async function repoWithSnapshot(githubId: number, sha: string) {
    const [repo] = await handle.db
      .insert(repositories)
      .values({ githubId, fullName: `octo/r${githubId}`, defaultBranch: 'main', isPrivate: false })
      .returning({ id: repositories.id });
    const index = await indexRepository(memory(PROJECT));
    const saved = await saveSnapshot(handle.db, repo?.id as string, sha, index);
    return saved.snapshotId as string;
  }

  it('builds topics for a snapshot whose summary predates READMEs and descriptions', async () => {
    const id = await repoWithSnapshot(1, 'a'.repeat(40));
    await handle.db.execute(
      sql`update repo_snapshots set summary = summary - 'readmes' where id = ${id}`,
    );
    const { describer } = fakeDescriber();
    const outcome = await buildSnapshotTopics(
      { db: handle.db, log: silent, describer, monthlyBudgetUsd: 2 },
      id,
      'octo/r1',
    );
    expect(outcome).toMatchObject({ topics: 2, described: 2 });
  });

  it('runs one build per repository at a time: a duplicate job pays for nothing', async () => {
    const id = await repoWithSnapshot(2, 'a'.repeat(40));
    const { describer, asked } = fakeDescriber();
    const deps = { db: handle.db, log: silent, describer, monthlyBudgetUsd: 2 };
    const [a, b] = await Promise.all([
      buildSnapshotTopics(deps, id, 'octo/r2'),
      buildSnapshotTopics(deps, id, 'octo/r2'),
    ]);
    expect(asked).toHaveLength(1); // the second build found the descriptions and reused them
    expect([a?.described, b?.described].sort()).toEqual([0, 2]);
    expect(await handle.db.select().from(llmUsage)).toHaveLength(1);
  });

  it('keeps the monthly cap across concurrent builds of different repositories', async () => {
    const first = await repoWithSnapshot(3, 'a'.repeat(40));
    const second = await repoWithSnapshot(4, 'b'.repeat(40));
    // Each build needs ~$0.6 worst case; the cap allows one of them, not both.
    const pricey: Describer = {
      provider: 'claude',
      model: 'fake-model',
      estimateCostUsd: () => 0.6,
      describe: async (_repo, briefs) => {
        await new Promise((r) => setTimeout(r, 50));
        return {
          descriptions: briefs.map((b) => ({
            id: b.id,
            name: 'X',
            summary: 'Y.',
            role: 'feature' as const,
          })),
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.6 },
        };
      },
    };
    const deps = { db: handle.db, log: silent, describer: pricey, monthlyBudgetUsd: 1 };
    await Promise.all([
      buildSnapshotTopics(deps, first, 'octo/r3'),
      buildSnapshotTopics(deps, second, 'octo/r4'),
    ]);
    const rows = await handle.db.select().from(llmUsage);
    const total = rows.reduce((sum, r) => sum + r.costUsd, 0);
    expect(total).toBeLessThanOrEqual(1);
  });
});
