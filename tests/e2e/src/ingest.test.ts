import { commits, type DatabaseHandle, ingestPush, repositories } from '@waymark/db';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, pushJob } from './helpers.ts';

describe('ingestPush (real Postgres)', () => {
  let handle: DatabaseHandle;

  beforeEach(async () => {
    await handle?.close();
    handle = await freshDatabase();
  });
  afterAll(async () => {
    await handle?.close();
  });

  const commitCount = async () => (await handle.db.select({ n: count() }).from(commits))[0]?.n;

  it('stores the repository and its commits', async () => {
    const job = pushJob({}, 3);
    const result = await ingestPush(handle.db, job);

    expect(result).toMatchObject({ received: 3, inserted: 3 });
    const [repo] = await handle.db.select().from(repositories);
    expect(repo).toMatchObject({ githubId: 1001, fullName: 'octo/demo', installationId: 42 });
    expect(await commitCount()).toBe(3);
  });

  it('is idempotent: replaying the same job inserts nothing', async () => {
    const job = pushJob({}, 5);
    await ingestPush(handle.db, job);
    const replay = await ingestPush(handle.db, job);

    expect(replay.inserted).toBe(0);
    expect(await commitCount()).toBe(5);
  });

  it('records a commit once even when it is pushed to a second branch', async () => {
    const job = pushJob({}, 2);
    await ingestPush(handle.db, job);
    const second = await ingestPush(handle.db, {
      ...job,
      deliveryId: 'other',
      branch: 'feature/x',
    });

    expect(second.inserted).toBe(0);
    const rows = await handle.db.select({ branch: commits.branch }).from(commits);
    expect(new Set(rows.map((r) => r.branch))).toEqual(new Set(['main']));
  });

  it('survives concurrent deliveries of the same push', async () => {
    const job = pushJob({}, 20);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => ingestPush(handle.db, { ...job, deliveryId: `d${i}` })),
    );

    expect(results.reduce((sum, r) => sum + r.inserted, 0)).toBe(20);
    expect(await commitCount()).toBe(20);
    expect((await handle.db.select().from(repositories)).length).toBe(1);
  });

  it('follows repository renames and visibility changes', async () => {
    await ingestPush(handle.db, pushJob());
    await ingestPush(
      handle.db,
      pushJob({
        repository: {
          githubId: 1001,
          fullName: 'octo/renamed',
          defaultBranch: 'trunk',
          isPrivate: true,
        },
      }),
    );

    const rows = await handle.db.select().from(repositories);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fullName: 'octo/renamed',
      defaultBranch: 'trunk',
      isPrivate: true,
    });
  });

  it('keeps the known installation id when a later event has none', async () => {
    await ingestPush(handle.db, pushJob());
    await ingestPush(handle.db, pushJob({ installationId: null }));
    const [repo] = await handle.db.select().from(repositories);
    expect(repo?.installationId).toBe(42);
  });

  it('tracks lastPushAt by receive time, not by (possibly wrong) commit timestamps', async () => {
    const job = pushJob({ receivedAt: '2026-11-13T15:00:00.000Z' });
    // A commit from a machine whose clock is a year ahead must not pin lastPushAt to the future.
    job.commits = job.commits.map((c) => ({ ...c, committedAt: '2027-11-13T15:00:00Z' }));
    await ingestPush(handle.db, job);

    const [repo] = await handle.db.select().from(repositories);
    expect(repo?.lastPushAt?.toISOString()).toBe('2026-11-13T15:00:00.000Z');
  });

  it('ignores stale events: a late retry can neither rewind lastPushAt nor undo a rename', async () => {
    const stale = pushJob({ receivedAt: '2026-11-13T09:00:00.000Z' });
    const fresh = pushJob({
      receivedAt: '2026-11-13T10:00:00.000Z',
      repository: {
        githubId: 1001,
        fullName: 'octo/renamed',
        defaultBranch: 'main',
        isPrivate: false,
      },
    });

    await ingestPush(handle.db, fresh);
    await ingestPush(handle.db, stale); // e.g. a job that sat in retry backoff

    const [repo] = await handle.db.select().from(repositories);
    expect(repo?.lastPushAt?.toISOString()).toBe('2026-11-13T10:00:00.000Z');
    expect(repo?.fullName).toBe('octo/renamed');
    expect(await commitCount()).toBe(2); // the stale push's commits are still recorded
  });

  it('handles a maximum-size push (GitHub sends at most 2048 commits)', async () => {
    const result = await ingestPush(handle.db, pushJob({}, 2048));
    expect(result.inserted).toBe(2048);
    expect(await commitCount()).toBe(2048);
  });

  it('cascades commit deletion with the repository', async () => {
    await ingestPush(handle.db, pushJob({}, 3));
    await handle.db.delete(repositories).where(eq(repositories.githubId, 1001));
    expect(await commitCount()).toBe(0);
  });
});
