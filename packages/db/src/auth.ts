/**
 * Dashboard users and sessions. A session token is 32 random bytes handed to the browser once;
 * only its SHA-256 is stored, so a leaked database cannot be replayed as a cookie.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from './client.ts';
import { repositories, sessions, users } from './schema.ts';

/**
 * How long a sign-in lasts. Short on purpose: what a session may see is the list of repositories
 * the user could access on GitHub when they signed in, so a lost access (removed from an org,
 * repository taken out of the App) must not linger. Signing in again is one click.
 */
export const SESSION_HOURS = 24;

export interface Viewer {
  userId: string;
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  repositoryIds: number[];
}

/**
 * Which repositories a request may see:
 * - `all`: everything, only when the dashboard runs without sign-in (localhost only);
 * - otherwise the repositories the viewer could access through the App at sign-in, while the App
 *   still has them (not detached), plus local demo repositories (negative ids from `pnpm demo`)
 *   only when the operator opted in: a demo may be a private folder of theirs.
 */
export type RepositoryScope =
  | { all: true }
  | { all: false; repositoryIds: number[]; demos: boolean };

export const ALL_REPOSITORIES: RepositoryScope = { all: true };

/** Sees nothing: what a request gets when something is wrong (fail closed). */
export const NO_REPOSITORIES: RepositoryScope = { all: false, repositoryIds: [], demos: false };

export function scopeOf(viewer: Viewer, options: { demos: boolean }): RepositoryScope {
  return { all: false, repositoryIds: viewer.repositoryIds, demos: options.demos };
}

/** SQL condition on `repositories` for a scope; `undefined` means no restriction. */
export function scopeCondition(scope: RepositoryScope) {
  if (scope.all) return undefined;
  const ids = scope.repositoryIds.filter((id) => Number.isSafeInteger(id) && id > 0);
  const granted =
    ids.length > 0
      ? and(inArray(repositories.githubId, ids), isNotNull(repositories.installationId))
      : sql`false`;
  return scope.demos ? or(granted, lt(repositories.githubId, 0)) : granted;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Creates or refreshes the user after a successful sign-in. */
export async function upsertUser(
  db: Database,
  user: {
    githubId: number;
    login: string;
    name: string | null;
    avatarUrl: string | null;
    repositoryIds: number[];
  },
): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ ...user, lastSignInAt: new Date() })
    .onConflictDoUpdate({
      target: users.githubId,
      set: {
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        repositoryIds: user.repositoryIds,
        lastSignInAt: new Date(),
      },
    })
    .returning({ id: users.id });
  if (!row) throw new Error('user was not stored');
  return row.id;
}

/** Starts a session and returns the token for the cookie (the only copy). */
export async function createSession(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3_600_000);
  await db.insert(sessions).values({ tokenHash: hash(token), userId, expiresAt });
  // Housekeeping: expired sessions are removed whenever someone signs in.
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  return { token, expiresAt };
}

/** The signed-in user for a cookie token, or null when it is unknown or expired. */
export async function findViewer(
  db: Database,
  token: string | undefined,
  now: Date = new Date(),
): Promise<Viewer | null> {
  // Our tokens are 43 base64url characters; anything else is not worth a query.
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await db
    .select({
      userId: users.id,
      githubId: users.githubId,
      login: users.login,
      name: users.name,
      avatarUrl: users.avatarUrl,
      repositoryIds: users.repositoryIds,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hash(token)), gt(sessions.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/** Signs a user out everywhere (e.g. after they were taken off the allowlist). */
export async function deleteUserSessions(db: Database, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** The stored user for a login, case-insensitively: who first signed in under that name. */
export async function findUserByLogin(db: Database, login: string) {
  const [row] = await db
    .select({ id: users.id, githubId: users.githubId })
    .from(users)
    .where(sql`lower(${users.login}) = lower(${login})`)
    .limit(1);
  return row ?? null;
}

export async function deleteSession(db: Database, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, hash(token)));
}

/**
 * The App was uninstalled, or repositories were removed from an installation: those repositories
 * stop belonging to it, so they disappear from every viewer's dashboard. Their history is kept;
 * reinstalling the App attaches them again on the next event.
 */
export async function detachInstallation(
  db: Database,
  installationId: number,
  githubIds?: number[],
): Promise<number> {
  const detach = async (ids?: number[]) =>
    (
      await db
        .update(repositories)
        .set({ installationId: null })
        .where(
          and(
            eq(repositories.installationId, installationId),
            ids ? inArray(repositories.githubId, ids) : undefined,
          ),
        )
        .returning({ id: repositories.id })
    ).length;
  if (!githubIds) return detach();
  let detached = 0;
  // Far below Postgres' 65,535 bind parameters per statement.
  for (let i = 0; i < githubIds.length; i += 10_000) {
    detached += await detach(githubIds.slice(i, i + 10_000));
  }
  return detached;
}
