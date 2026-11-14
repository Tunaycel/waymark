import type { PushJob } from '@waymark/core';
import { createDatabase, type DatabaseHandle, runMigrations } from '@waymark/db';
import { sql } from 'drizzle-orm';

/**
 * A database of its own, never the one in `.env`: every test truncates all tables, which would wipe
 * the dashboard's data and the AI spending ledger the monthly budget is enforced against.
 */
export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? testUrlFrom(process.env.DATABASE_URL);

/** The same server as DATABASE_URL (or the docker compose default), database `<name>_test`. */
function testUrlFrom(url = 'postgres://waymark:waymark@localhost:5433/waymark'): string {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.slice(1)) || 'waymark';
  parsed.pathname = `/${name.endsWith('_test') ? name : `${name}_test`}`;
  return parsed.toString();
}
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

let ensured: Promise<void> | undefined;

/** Creates the test database on first use; refuses to run against one not named `*_test`. */
function ensureTestDatabase(): Promise<void> {
  ensured ??= (async () => {
    const url = new URL(DATABASE_URL);
    const name = decodeURIComponent(url.pathname.slice(1));
    if (!/^[A-Za-z0-9_]+_test$/.test(name)) {
      throw new Error(`refusing to truncate "${name}": test database names must end in _test`);
    }
    url.pathname = '/postgres';
    const admin = createDatabase(url.toString(), { max: 1 });
    try {
      const existing = await admin.db.execute(
        sql`select 1 from pg_database where datname = ${name}`,
      );
      if (existing.length === 0) {
        await admin.db.execute(sql.raw(`create database "${name}"`)).catch((error: unknown) => {
          // Another test file created it first.
          if ((error as { code?: string }).code !== '42P04') throw error;
        });
      }
    } finally {
      await admin.close();
    }
  })();
  return ensured;
}

export async function freshDatabase(): Promise<DatabaseHandle> {
  await ensureTestDatabase();
  await runMigrations(DATABASE_URL);
  const handle = createDatabase(DATABASE_URL, { max: 5 });
  await handle.db.execute(
    sql`truncate table llm_usage, repository_topics, snapshot_topic_edges, snapshot_topics, snapshot_edges, snapshot_files, repo_snapshots, commits, repositories restart identity cascade`,
  );
  return handle;
}

let shaCounter = 0;
/** Unique, valid 40-char hex SHA per call. */
export function sha(): string {
  shaCounter += 1;
  return shaCounter.toString(16).padStart(40, '0');
}

let receivedCounter = 0;
/** Each job is received one second after the previous one, so later calls are "newer". */
export function pushJob(overrides: Partial<PushJob> = {}, commitCount = 1): PushJob {
  receivedCounter += 1;
  return {
    deliveryId: crypto.randomUUID(),
    receivedAt: new Date(Date.UTC(2026, 10, 13, 12, 0, 0) + receivedCounter * 1000).toISOString(),
    installationId: 42,
    repository: {
      githubId: 1001,
      fullName: 'octo/demo',
      defaultBranch: 'main',
      isPrivate: false,
    },
    branch: 'main',
    forced: false,
    commits: Array.from({ length: commitCount }, (_, i) => {
      const id = sha();
      return {
        sha: id,
        message: `commit ${i}`,
        authorName: 'Octo Cat',
        authorUsername: 'octocat',
        committedAt: new Date(Date.UTC(2026, 10, 13, 9, i % 60)).toISOString(),
        url: `https://github.com/octo/demo/commit/${id}`,
        files: { added: [], removed: [], modified: ['README.md'] },
      };
    }),
    ...overrides,
  };
}

export async function waitFor<T>(
  check: () => Promise<T | undefined>,
  { timeoutMs = 10_000, intervalMs = 50 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
