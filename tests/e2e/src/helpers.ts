import type { PushJob } from '@waymark/core';
import { createDatabase, type DatabaseHandle, runMigrations } from '@waymark/db';
import { sql } from 'drizzle-orm';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://waymark:waymark@localhost:5433/waymark';
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

export async function freshDatabase(): Promise<DatabaseHandle> {
  await runMigrations(DATABASE_URL);
  const handle = createDatabase(DATABASE_URL, { max: 5 });
  await handle.db.execute(sql`truncate table commits, repositories restart identity cascade`);
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
