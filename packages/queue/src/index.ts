import type { PushJob } from '@waymark/core';
import { type JobsOptions, Queue, type QueueOptions, Worker, type WorkerOptions } from 'bullmq';
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

export type { Queue, Worker } from 'bullmq';
