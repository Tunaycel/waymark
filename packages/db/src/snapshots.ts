import type { RepoIndex } from '@waymark/indexer';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { Database } from './client.ts';
import { cleanJson } from './sanitize.ts';
import { repoSnapshots, repositories, snapshotEdges, snapshotFiles } from './schema.ts';

/** Snapshots kept per repository; older ones are pruned when a new one is saved. */
export const SNAPSHOTS_KEPT = 3;

/** 8 columns x 1,000 rows and 3 x 5,000 stay well under Postgres' 65,535-parameter limit. */
const FILE_CHUNK = 1_000;
const EDGE_CHUNK = 5_000;

export interface SaveSnapshotResult {
  snapshotId: string | null;
  /** `false` when this commit was already indexed (a retry or a concurrent job got there first). */
  created: boolean;
}

/**
 * Stores an index in one transaction: snapshot row, files, edges, then prunes old snapshots.
 * Idempotent per (repository, commit).
 */
export async function saveSnapshot(
  db: Database,
  repositoryId: string,
  commitSha: string,
  index: RepoIndex,
): Promise<SaveSnapshotResult> {
  const { files, edges, ...summary } = cleanJson(index);
  return db.transaction(async (tx) => {
    const [snapshot] = await tx
      .insert(repoSnapshots)
      .values({
        repositoryId,
        commitSha,
        durationMs: index.stats.durationMs,
        fileCount: files.length,
        edgeCount: edges.length,
        truncated: index.stats.truncated,
        summary,
      })
      .onConflictDoNothing({ target: [repoSnapshots.repositoryId, repoSnapshots.commitSha] })
      .returning({ id: repoSnapshots.id });
    if (!snapshot) return { snapshotId: null, created: false };

    for (let i = 0; i < files.length; i += FILE_CHUNK) {
      await tx.insert(snapshotFiles).values(
        files.slice(i, i + FILE_CHUNK).map((f) => ({
          snapshotId: snapshot.id,
          path: f.path,
          language: f.language,
          kind: f.kind,
          module: f.module,
          size: f.size,
          lines: f.lines,
          blobSha: f.blobSha,
        })),
      );
    }
    for (let i = 0; i < edges.length; i += EDGE_CHUNK) {
      await tx.insert(snapshotEdges).values(
        edges.slice(i, i + EDGE_CHUNK).map((e) => ({
          snapshotId: snapshot.id,
          fromPath: e.from,
          toPath: e.to,
        })),
      );
    }

    const keep = tx
      .select({ id: repoSnapshots.id })
      .from(repoSnapshots)
      .where(eq(repoSnapshots.repositoryId, repositoryId))
      .orderBy(desc(repoSnapshots.indexedAt), desc(repoSnapshots.id))
      .limit(SNAPSHOTS_KEPT);
    await tx
      .delete(repoSnapshots)
      .where(and(eq(repoSnapshots.repositoryId, repositoryId), notInArray(repoSnapshots.id, keep)));

    return { snapshotId: snapshot.id, created: true };
  });
}

export async function hasSnapshot(
  db: Database,
  repositoryId: string,
  commitSha: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: repoSnapshots.id })
    .from(repoSnapshots)
    .where(
      and(eq(repoSnapshots.repositoryId, repositoryId), eq(repoSnapshots.commitSha, commitSha)),
    )
    .limit(1);
  return row !== undefined;
}

export async function latestSnapshot(db: Database, repositoryId: string) {
  const [row] = await db
    .select()
    .from(repoSnapshots)
    .where(eq(repoSnapshots.repositoryId, repositoryId))
    .orderBy(desc(repoSnapshots.indexedAt), desc(repoSnapshots.id))
    .limit(1);
  return row ?? null;
}

export interface RepositoryUpsert {
  githubId: number;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  installationId: number | null;
}

/**
 * Creates or refreshes a repository from GitHub's API (e.g. when an App is installed before any
 * push). The API response is current, so it overwrites metadata; push freshness is left untouched.
 */
export async function upsertRepository(db: Database, repo: RepositoryUpsert): Promise<string> {
  const [row] = await db
    .insert(repositories)
    .values(repo)
    .onConflictDoUpdate({
      target: repositories.githubId,
      set: {
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        isPrivate: repo.isPrivate,
        installationId: sql`coalesce(excluded.installation_id, ${repositories.installationId})`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: repositories.id });
  if (!row) throw new Error(`Failed to upsert repository ${repo.fullName}`);
  return row.id;
}
