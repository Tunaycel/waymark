import { EnvError, loadBaseEnv } from '@waymark/core';
import { createDatabase } from '@waymark/db';
import { createGitHubEventsWorker } from '@waymark/queue';
import { createLogger, createProcessor } from './processor.ts';

let env: ReturnType<typeof loadBaseEnv>;
try {
  env = loadBaseEnv();
} catch (err) {
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const log = createLogger(env.LOG_LEVEL);
const database = createDatabase(env.DATABASE_URL);
const worker = createGitHubEventsWorker(env.REDIS_URL, createProcessor(database.db, log));

// Pass errors as `err` so pino's serializer keeps the stack and code (AggregateError has no message).
worker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, attempt: job?.attemptsMade, err }, 'job failed');
});
worker.on('error', (err) => log.error({ err }, 'worker error'));

/** Running jobs get this long to finish before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 25_000;
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  setTimeout(() => {
    log.error('graceful shutdown timed out, exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  // Finishes the jobs currently running, then releases Redis and Postgres.
  await worker.close();
  await database.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await worker.waitUntilReady();
log.info({ concurrency: worker.opts.concurrency }, 'worker ready');
