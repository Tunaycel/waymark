import { type Database, ingestPush } from '@waymark/db';
import type { GitHubEventJob, IndexJob } from '@waymark/queue';
import { type Logger, pino } from 'pino';

export function createLogger(level: string): Logger {
  return pino({ level, base: { service: 'worker' } });
}

export interface ProcessorOptions {
  /** Schedules re-indexing after a push to the default branch. Absent: indexing is disabled. */
  enqueueIndex?: (job: IndexJob) => Promise<void>;
}

/** Routes each queued GitHub event to its handler. Throwing makes BullMQ retry with backoff. */
export function createProcessor(db: Database, log: Logger, options: ProcessorOptions = {}) {
  return async (job: GitHubEventJob) => {
    switch (job.type) {
      case 'push': {
        const push = job.payload;
        const started = performance.now();
        const result = await ingestPush(db, push);
        log.info(
          {
            deliveryId: push.deliveryId,
            repo: push.repository.fullName,
            branch: push.branch,
            received: result.received,
            inserted: result.inserted,
            ms: Math.round(performance.now() - started),
          },
          'push ingested',
        );
        // The map follows the default branch. Enqueue failures throw, so the push is retried;
        // re-ingesting it is a no-op and the debounce collapses the duplicate index request.
        if (
          options.enqueueIndex &&
          push.branch === push.repository.defaultBranch &&
          push.installationId !== null
        ) {
          await options.enqueueIndex({
            githubId: push.repository.githubId,
            fullName: push.repository.fullName,
            installationId: push.installationId,
            sha: null,
            reason: 'push',
          });
        }
        return result;
      }
      default: {
        // A job type without a handler must fail loudly, not be marked "completed" and lost.
        const unknown: never = job.type;
        throw new Error(`No handler for job type ${String(unknown)}`);
      }
    }
  };
}
