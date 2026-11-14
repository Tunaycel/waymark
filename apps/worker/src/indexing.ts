import { type Database, findSnapshot, saveSnapshot, upsertRepository } from '@waymark/db';
import { GitHubApiError, type GitHubApp } from '@waymark/github';
import {
  DEFAULT_LIMITS,
  IndexCrashedError,
  type IndexLimits,
  IndexTimeoutError,
  indexIsolated,
} from '@waymark/indexer';
import { type IndexJob, UnrecoverableError } from '@waymark/queue';
import type { Logger } from 'pino';
import { buildSnapshotTopics, type TopicDeps } from './topics.ts';

export type IndexingGitHub = Pick<GitHubApp, 'getRepository' | 'resolveRef' | 'downloadTarball'>;

export interface IndexProcessorDeps {
  db: Database;
  github: IndexingGitHub;
  log: Logger;
  limits?: IndexLimits;
  /** Hard budget for downloading and indexing one repository (the process is killed after it). */
  timeoutMs?: number;
  /** Heap budget of the indexing process. */
  maxHeapMb?: number;
  /** Topic building after indexing (AI describer and budget). Absent: no topics. */
  topics?: Omit<TopicDeps, 'db' | 'log'>;
}

export type IndexOutcome =
  | { status: 'indexed'; sha: string; files: number; edges: number; ms: number }
  | { status: 'unchanged'; sha: string }
  | { status: 'skipped'; reason: string };

/**
 * Indexes one repository at the current head of its default branch (or a given commit):
 * resolve → skip if already indexed → stream the tarball → index → store.
 */
export function createIndexProcessor(deps: IndexProcessorDeps) {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const timeoutMs = deps.timeoutMs ?? 10 * 60_000;

  /** Topics are a layer on top of the index: their failure is logged, never fails the job. */
  const buildTopics = async (snapshotId: string, repoName: string) => {
    if (!deps.topics) return;
    try {
      await buildSnapshotTopics(
        { ...deps.topics, db: deps.db, log: deps.log },
        snapshotId,
        repoName,
      );
    } catch (err) {
      deps.log.error({ err, repo: repoName, snapshotId }, 'topic building failed');
    }
  };

  return async (job: IndexJob): Promise<IndexOutcome> => {
    try {
      // Current metadata: the repository may have been renamed since the event was queued.
      const repo = await deps.github.getRepository(job.installationId, job.fullName);
      if (repo.githubId !== job.githubId) {
        // The name now belongs to a different repository (deleted and recreated, or transferred).
        return { status: 'skipped', reason: 'repository_replaced' };
      }
      const repositoryId = await upsertRepository(deps.db, {
        ...repo,
        installationId: job.installationId,
      });

      const sha =
        job.sha ??
        (await deps.github.resolveRef(job.installationId, repo.fullName, repo.defaultBranch));
      const existing = await findSnapshot(deps.db, repositoryId, sha);
      if (existing) {
        // Indexed before topics existed (or their build failed): build them now.
        if (!existing.topicsBuiltAt) await buildTopics(existing.id, repo.fullName);
        return { status: 'unchanged', sha };
      }

      const started = performance.now();
      const signal = AbortSignal.timeout(timeoutMs);
      const tarball = await deps.github.downloadTarball(
        job.installationId,
        repo.fullName,
        sha,
        signal,
      );
      // Untrusted content is indexed in a separate process with hard time and memory budgets, so
      // a pathological repository can't block or crash this one (or the queue lock it renews).
      const index = await indexIsolated(tarball, {
        limits,
        timeoutMs,
        ...(deps.maxHeapMb ? { maxHeapMb: deps.maxHeapMb } : {}),
      });
      const saved = await saveSnapshot(deps.db, repositoryId, sha, index);
      const ms = Math.round(performance.now() - started);

      deps.log.info(
        {
          repo: repo.fullName,
          sha,
          reason: job.reason,
          files: index.stats.files,
          edges: index.edges.length,
          modules: index.modules.length,
          truncated: index.stats.truncated,
          created: saved.created,
          ms,
        },
        'repository indexed',
      );
      if (!saved.created || !saved.snapshotId) return { status: 'unchanged', sha };
      await buildTopics(saved.snapshotId, repo.fullName);
      return { status: 'indexed', sha, files: index.stats.files, edges: index.edges.length, ms };
    } catch (err) {
      if (err instanceof GitHubApiError) {
        // 409 from the commits API: the repository has no commits yet. Nothing to map.
        if (err.status === 409) return { status: 'skipped', reason: 'empty_repository' };
        // Gone or inaccessible (uninstalled, deleted): retrying cannot help.
        if (err.permanent) throw new UnrecoverableError(err.message);
      }
      // The same content would exceed the same budget again; fail once instead of four times.
      // The next push to the repository tries again.
      if (
        err instanceof IndexTimeoutError ||
        (err instanceof IndexCrashedError && err.outOfMemory)
      ) {
        deps.log.warn({ repo: job.fullName, err }, 'repository exceeded its indexing budget');
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  };
}
