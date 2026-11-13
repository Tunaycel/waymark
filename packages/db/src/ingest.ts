import type { PushJob } from '@waymark/core';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Database } from './client.ts';
import { commits, repositories } from './schema.ts';

export interface IngestResult {
  repositoryId: string;
  received: number;
  inserted: number;
}

/** Postgres caps a statement at 65,535 bind parameters; 500 rows x 11 columns stays far below. */
const INSERT_CHUNK = 500;

/**
 * Persists a push: upserts the repository, then inserts commits it hasn't seen.
 * Runs in one transaction and is safe to retry — re-running the same job inserts nothing new.
 */
export async function ingestPush(db: Database, job: PushJob): Promise<IngestResult> {
  return db.transaction(async (tx) => {
    // An event is "newer" if Waymark received it later. Only newer events may overwrite mutable
    // repository metadata, so a delayed retry of an old delivery can't undo a rename.
    const isNewer = sql`excluded.last_push_at >= coalesce(${repositories.lastPushAt}, '-infinity')`;
    const ifNewer = (column: AnyPgColumn, excluded: string) =>
      sql`case when ${isNewer} then ${sql.raw(`excluded.${excluded}`)} else ${column} end`;

    const [repo] = await tx
      .insert(repositories)
      .values({
        githubId: job.repository.githubId,
        fullName: job.repository.fullName,
        defaultBranch: job.repository.defaultBranch,
        isPrivate: job.repository.isPrivate,
        installationId: job.installationId,
        lastPushAt: new Date(job.receivedAt),
      })
      .onConflictDoUpdate({
        target: repositories.githubId,
        set: {
          // Repos get renamed / transferred / change visibility; follow the newest event.
          fullName: ifNewer(repositories.fullName, 'full_name'),
          defaultBranch: ifNewer(repositories.defaultBranch, 'default_branch'),
          isPrivate: ifNewer(repositories.isPrivate, 'is_private'),
          installationId: sql`coalesce(excluded.installation_id, ${repositories.installationId})`,
          lastPushAt: sql`greatest(${repositories.lastPushAt}, excluded.last_push_at)`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: repositories.id });

    if (!repo) throw new Error(`Failed to upsert repository ${job.repository.fullName}`);

    let inserted = 0;
    for (let i = 0; i < job.commits.length; i += INSERT_CHUNK) {
      const rows = job.commits.slice(i, i + INSERT_CHUNK).map((c) => ({
        repositoryId: repo.id,
        sha: c.sha,
        branch: job.branch,
        message: c.message,
        authorName: c.authorName,
        authorUsername: c.authorUsername,
        committedAt: new Date(c.committedAt),
        url: c.url,
        files: c.files,
      }));
      const result = await tx
        .insert(commits)
        .values(rows)
        .onConflictDoNothing({ target: [commits.repositoryId, commits.sha] })
        .returning({ id: commits.id });
      inserted += result.length;
    }

    return { repositoryId: repo.id, received: job.commits.length, inserted };
  });
}
