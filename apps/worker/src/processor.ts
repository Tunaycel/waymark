import { type Database, ingestPush } from '@waymark/db';
import type { GitHubEventJob } from '@waymark/queue';
import { type Logger, pino } from 'pino';

export function createLogger(level: string): Logger {
  return pino({ level, base: { service: 'worker' } });
}

/** Routes each queued GitHub event to its handler. Throwing makes BullMQ retry with backoff. */
export function createProcessor(db: Database, log: Logger) {
  return async (job: GitHubEventJob) => {
    switch (job.type) {
      case 'push': {
        const started = performance.now();
        const result = await ingestPush(db, job.payload);
        log.info(
          {
            deliveryId: job.payload.deliveryId,
            repo: job.payload.repository.fullName,
            branch: job.payload.branch,
            received: result.received,
            inserted: result.inserted,
            ms: Math.round(performance.now() - started),
          },
          'push ingested',
        );
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
