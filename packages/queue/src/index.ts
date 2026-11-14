import type { PushJob } from '@waymark/core';
import {
  type JobsOptions,
  Queue,
  type QueueOptions,
  UnrecoverableError,
  Worker,
  type WorkerOptions,
} from 'bullmq';
import { Redis } from 'ioredis';

export const GITHUB_EVENTS_QUEUE = 'github-events';

export type GitHubEventJob = { type: 'push'; payload: PushJob };

/** Retry transient failures (DB/Redis blips) with exponential backoff: 2s, 4s, 8s, 16s, 32s. */
export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

/**
 * Producers (the HTTP server) must fail fast: if Redis is down, a webhook request should get an
 * error within seconds, not hang past GitHub's 10 s timeout while commands pile up in memory.
 */
function producerConnection(redisUrl: string) {
  return {
    url: redisUrl,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  };
}

/** Workers block waiting for jobs and must ride out Redis restarts; BullMQ requires this config. */
function workerConnection(redisUrl: string) {
  return { url: redisUrl, maxRetriesPerRequest: null };
}

export function createGitHubEventsQueue(
  redisUrl: string,
  options: Omit<QueueOptions, 'connection'> = {},
): Queue<GitHubEventJob> {
  return new Queue<GitHubEventJob>(GITHUB_EVENTS_QUEUE, {
    connection: producerConnection(redisUrl),
    defaultJobOptions,
    ...options,
  });
}

/**
 * GitHub redelivers webhooks (manual "Redeliver", or after timeouts). Using the delivery GUID as
 * the job id makes BullMQ drop duplicates while the original job is still retained.
 * BullMQ forbids ':' in custom ids, hence the '-' separator.
 */
export function jobIdForDelivery(type: GitHubEventJob['type'], deliveryId: string): string {
  return `${type}-${deliveryId}`;
}

export class EnqueueTimeoutError extends Error {
  constructor(ms: number) {
    super(`Enqueue did not complete within ${ms}ms`);
    this.name = 'EnqueueTimeoutError';
  }
}

/** Leaves headroom under GitHub's 10 s webhook timeout for the rest of the request. */
export const ENQUEUE_TIMEOUT_MS = 5_000;

export type EnqueueOutcome = { jobId: string; status: 'queued' | 'duplicate' | 'requeued' };

/**
 * Adds a push to the queue, at most once per delivery.
 *
 * - New delivery → queued.
 * - Redelivery of a job that is pending or done → duplicate (no-op).
 * - Redelivery of a job that exhausted its retries → requeued. Without this, the one recovery tool
 *   GitHub gives you ("Redeliver") would be silently swallowed for as long as the failed job is kept.
 *   Reprocessing is safe because ingestion is idempotent.
 */
export async function enqueuePush(
  queue: Queue<GitHubEventJob>,
  job: PushJob,
  timeoutMs = ENQUEUE_TIMEOUT_MS,
): Promise<EnqueueOutcome> {
  const jobId = jobIdForDelivery('push', job.deliveryId);
  return withTimeout(timeoutMs, async () => {
    const existing = await queue.getJob(jobId);
    if (existing) {
      if (await existing.isFailed()) {
        // Two redeliveries can race here; whoever loses finds the job no longer failed.
        const retried = await existing.retry('failed').then(
          () => true,
          () => false,
        );
        return { jobId, status: retried ? 'requeued' : 'duplicate' };
      }
      return { jobId, status: 'duplicate' };
    }
    await queue.add('push', { type: 'push', payload: job }, { jobId });
    return { jobId, status: 'queued' };
  });
}

async function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EnqueueTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createGitHubEventsWorker(
  redisUrl: string,
  processor: (job: GitHubEventJob) => Promise<unknown>,
  options: Omit<WorkerOptions, 'connection'> = {},
): Worker<GitHubEventJob> {
  return new Worker<GitHubEventJob>(GITHUB_EVENTS_QUEUE, (job) => processor(job.data), {
    connection: workerConnection(redisUrl),
    concurrency: 4,
    ...options,
  });
}

/**
 * A dedicated, fail-fast Redis connection for readiness probes. With the offline queue disabled,
 * PING rejects immediately while Redis is unreachable instead of hanging the probe.
 */
export function createRedisHealthCheck(redisUrl: string) {
  const client = new Redis(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  });
  client.on('error', () => {}); // surfaced through isReady() instead of crashing the process
  return {
    isReady: async () => (await client.ping()) === 'PONG',
    close: async () => {
      client.disconnect();
    },
  };
}

export const REPO_INDEX_QUEUE = 'repo-index';

/** Build the structural index of one repository. */
export interface IndexJob {
  githubId: number;
  fullName: string;
  installationId: number;
  /**
   * Commit to index; `null` means "whatever the default branch points to when the job runs".
   * Pushes use `null`: push jobs can be processed out of order, and resolving the head at run time
   * guarantees the map ends up on the newest commit.
   */
  sha: string | null;
  reason: 'push' | 'installation';
}

/**
 * Pushes often come in bursts (several commits pushed one after another, a rebase). Indexing waits
 * this long after the last push to a repository and then indexes only the newest commit.
 */
export const INDEX_DEBOUNCE_MS = 15_000;

export const indexJobOptions: JobsOptions = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 500 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

export function createIndexQueue(
  redisUrl: string,
  options: Omit<QueueOptions, 'connection'> = {},
): Queue<IndexJob> {
  return new Queue<IndexJob>(REPO_INDEX_QUEUE, {
    connection: producerConnection(redisUrl),
    defaultJobOptions: indexJobOptions,
    ...options,
  });
}

/**
 * Schedules indexing, at most one pending and one running job per repository:
 *
 * - while a job is still waiting out its delay, a newer request replaces it and restarts the delay
 *   (debounce: a burst of pushes is indexed once);
 * - while a job is running, the newest request is kept and starts as soon as it finishes, so a push
 *   that lands mid-run is never dropped and two runs never overlap.
 *
 * The job resolves the default branch head when it runs, so whichever request survives indexes
 * the newest commit. Installation events pass `debounceMs = 0`.
 */
export async function enqueueIndex(
  queue: Queue<IndexJob>,
  job: IndexJob,
  debounceMs = INDEX_DEBOUNCE_MS,
): Promise<void> {
  await withTimeout(ENQUEUE_TIMEOUT_MS, () =>
    queue.add('index', job, {
      delay: debounceMs,
      deduplication: { id: `repo-${job.githubId}`, replace: true, keepLastIfActive: true },
    }),
  );
}

export function createIndexWorker(
  redisUrl: string,
  processor: (job: IndexJob) => Promise<unknown>,
  options: Omit<WorkerOptions, 'connection'> = {},
): Worker<IndexJob> {
  return new Worker<IndexJob>(REPO_INDEX_QUEUE, (job) => processor(job.data), {
    connection: workerConnection(redisUrl),
    // Indexing is CPU- and memory-heavy; one repository at a time per worker process.
    concurrency: 1,
    // Large repositories take a while; the lock is renewed in the background meanwhile.
    lockDuration: 120_000,
    ...options,
  });
}

export type { Queue, Worker } from 'bullmq';
export { UnrecoverableError };
