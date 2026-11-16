import {
  ALL_REPOSITORIES,
  createSession,
  type DatabaseHandle,
  deleteSession,
  deleteUserSessions,
  detachInstallation,
  findRepository,
  findUserByLogin,
  findViewer,
  listRepositoryCards,
  NO_REPOSITORIES,
  repositories,
  SESSION_HOURS,
  scopeOf,
  sessions,
  upsertUser,
  users,
} from '@waymark/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from './helpers.ts';

describe('users and sessions → Postgres', () => {
  let handle: DatabaseHandle;
  const me = { githubId: 190946090, login: 'Tunaycel', name: 'T', avatarUrl: null };

  beforeEach(async () => {
    handle = await freshDatabase();
  });
  afterEach(async () => {
    await handle.close();
  });

  it('creates a session whose token is never stored, and finds the viewer by it', async () => {
    const userId = await upsertUser(handle.db, { ...me, repositoryIds: [11, 12] });
    const { token, expiresAt } = await createSession(handle.db, userId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan((SESSION_HOURS - 1) * 3_600_000);

    const stored = await handle.db.select().from(sessions);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).not.toBe(token);
    expect(stored[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const viewer = await findViewer(handle.db, token);
    expect(viewer).toMatchObject({ login: 'Tunaycel', repositoryIds: [11, 12] });
  });

  it('refuses unknown, malformed, expired, and deleted tokens', async () => {
    const userId = await upsertUser(handle.db, { ...me, repositoryIds: [] });
    const { token } = await createSession(handle.db, userId);
    expect(await findViewer(handle.db, undefined)).toBeNull();
    expect(await findViewer(handle.db, 'short')).toBeNull();
    expect(await findViewer(handle.db, `${token.slice(0, -1)}A`)).toBeNull();
    expect(await findViewer(handle.db, `${token}'; drop table users; --`)).toBeNull();
    const later = new Date(Date.now() + (SESSION_HOURS + 1) * 3_600_000);
    expect(await findViewer(handle.db, token, later)).toBeNull();
    await deleteSession(handle.db, token);
    expect(await findViewer(handle.db, token)).toBeNull();
  });

  it('updates a returning user instead of duplicating them, refreshing what they can see', async () => {
    const first = await upsertUser(handle.db, { ...me, repositoryIds: [1] });
    const second = await upsertUser(handle.db, {
      ...me,
      login: 'tunaycel-renamed',
      repositoryIds: [1, 2],
    });
    expect(second).toBe(first);
    const [row] = await handle.db.select().from(users).where(eq(users.id, first));
    expect(row).toMatchObject({ login: 'tunaycel-renamed', repositoryIds: [1, 2] });
  });

  it('cleans up expired sessions when someone signs in', async () => {
    const userId = await upsertUser(handle.db, { ...me, repositoryIds: [] });
    const old = new Date(Date.now() - (SESSION_HOURS + 2) * 3_600_000);
    await createSession(handle.db, userId, old);
    await createSession(handle.db, userId);
    expect(await handle.db.select().from(sessions)).toHaveLength(1);
  });
});

describe('who sees which repository → Postgres', () => {
  let handle: DatabaseHandle;

  beforeEach(async () => {
    handle = await freshDatabase();
    const repo = (githubId: number, fullName: string, installationId: number | null) => ({
      githubId,
      fullName,
      defaultBranch: 'main',
      isPrivate: true,
      installationId,
    });
    await handle.db.insert(repositories).values([
      repo(1, 'me/app', 100),
      repo(2, 'org/api', 200),
      // Same organisation installation, but a repository this member can't open on GitHub.
      repo(6, 'org/payroll', 200),
      repo(3, 'stranger/x', 300),
      repo(4, 'old/detached', null),
      repo(-5, 'local/demo', null),
    ]);
  });
  afterEach(async () => {
    await handle.close();
  });

  const viewer = (repositoryIds: number[], demos = false) =>
    scopeOf(
      { userId: 'u', githubId: 9, login: 'me', name: null, avatarUrl: null, repositoryIds },
      { demos },
    );
  const names = async (scope: Parameters<typeof listRepositoryCards>[1]) =>
    (await listRepositoryCards(handle.db, scope)).map((c) => c.fullName).sort();

  it('shows a viewer exactly the repositories they can open, not their whole organisation', async () => {
    expect(await names(viewer([1, 2]))).toEqual(['me/app', 'org/api']);
    expect(await names(viewer([]))).toEqual([]);
    expect(await names(NO_REPOSITORIES)).toEqual([]);
    expect(await names(ALL_REPOSITORIES)).toHaveLength(6);
  });

  it('shows local demos only when the operator opted in', async () => {
    expect(await names(viewer([1], true))).toEqual(['local/demo', 'me/app']);
    expect(await names(viewer([1], false))).toEqual(['me/app']);
  });

  it('ignores ids that are not repository ids', async () => {
    expect(await names(viewer([-5, 0, Number.NaN, 2 ** 60]))).toEqual([]);
  });

  it("can't open a repository outside the scope by name", async () => {
    expect(await findRepository(handle.db, 'org/payroll', viewer([1, 2]))).toBeNull();
    expect(await findRepository(handle.db, 'ME/APP', viewer([1]))).not.toBeNull();
  });

  it('hides repositories the App lost access to, even from someone who could see them', async () => {
    expect(await detachInstallation(handle.db, 200, [2])).toBe(1);
    expect(await names(viewer([1, 2]))).toEqual(['me/app']);
    // Uninstalling the App from an account detaches all of its repositories.
    expect(await detachInstallation(handle.db, 100)).toBe(1);
    expect(await names(viewer([1, 2]))).toEqual([]);
    // An empty list detaches nothing (not everything).
    expect(await detachInstallation(handle.db, 300, [])).toBe(0);
  });

  it('detaches very large removals in chunks', async () => {
    const ids = [3, ...Array.from({ length: 70_000 }, (_, i) => 1_000_000 + i)];
    expect(await detachInstallation(handle.db, 300, ids)).toBe(1);
  });
});

describe('a login belongs to the account that first used it → Postgres', () => {
  let handle: DatabaseHandle;
  beforeEach(async () => {
    handle = await freshDatabase();
  });
  afterEach(async () => {
    await handle.close();
  });

  it('finds the original account by login, case-insensitively', async () => {
    await upsertUser(handle.db, {
      githubId: 1,
      login: 'Alice',
      name: null,
      avatarUrl: null,
      repositoryIds: [],
    });
    expect(await findUserByLogin(handle.db, 'alice')).toMatchObject({ githubId: 1 });
    expect(await findUserByLogin(handle.db, 'bob')).toBeNull();
  });

  it('signs a user out everywhere', async () => {
    const id = await upsertUser(handle.db, {
      githubId: 1,
      login: 'alice',
      name: null,
      avatarUrl: null,
      repositoryIds: [],
    });
    const a = await createSession(handle.db, id);
    const b = await createSession(handle.db, id);
    await deleteUserSessions(handle.db, id);
    expect(await findViewer(handle.db, a.token)).toBeNull();
    expect(await findViewer(handle.db, b.token)).toBeNull();
  });
});
