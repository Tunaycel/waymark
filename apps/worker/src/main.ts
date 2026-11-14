import { EnvError, loadWorkerEnv } from '@waymark/core';
import { createDatabase } from '@waymark/db';
import { GitHubApp } from '@waymark/github';
import { ClaudeDescriber, type Describer, OllamaDescriber } from '@waymark/mapper';
import {
  createGitHubEventsWorker,
  createIndexQueue,
  createIndexWorker,
  enqueueIndex,
} from '@waymark/queue';
import { createIndexProcessor } from './indexing.ts';
import { createLogger, createProcessor } from './processor.ts';

let env: ReturnType<typeof loadWorkerEnv>;
let github: GitHubApp | null = null;
try {
  env = loadWorkerEnv();
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
    try {
      github = new GitHubApp({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        apiUrl: env.GITHUB_API_URL,
      });
    } catch (err) {
      throw new EnvError([`GITHUB_APP_PRIVATE_KEY: cannot be parsed (${(err as Error).message})`]);
    }
  }
} catch (err) {
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const log = createLogger(env.LOG_LEVEL);
const database = createDatabase(env.DATABASE_URL);
const describer = topicDescriber(env);
const indexQueue = github ? createIndexQueue(env.REDIS_URL) : null;
indexQueue?.on('error', (err) => log.error({ err }, 'index queue connection error'));

const eventsWorker = createGitHubEventsWorker(
  env.REDIS_URL,
  createProcessor(database.db, log, {
    ...(indexQueue ? { enqueueIndex: (job) => enqueueIndex(indexQueue, job) } : {}),
  }),
);
const indexWorker = github
  ? createIndexWorker(
      env.REDIS_URL,
      createIndexProcessor({
        db: database.db,
        github,
        log,
        topics: {
          describer,
          monthlyBudgetUsd: env.WAYMARK_LLM_MONTHLY_BUDGET_USD,
        },
      }),
    )
  : null;
if (!github) {
  log.warn('GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not set: repository indexing is disabled');
}

// Pass errors as `err` so pino's serializer keeps the stack and code (AggregateError has no message).
for (const [name, worker] of [
  ['events', eventsWorker],
  ['index', indexWorker],
] as const) {
  worker?.on('failed', (job, err) => {
    log.error({ queue: name, jobId: job?.id, attempt: job?.attemptsMade, err }, 'job failed');
  });
  worker?.on('error', (err) => log.error({ queue: name, err }, 'worker error'));
}

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
  await Promise.all([eventsWorker.close(), indexWorker?.close()]);
  await indexQueue?.close();
  await database.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await Promise.all([eventsWorker.waitUntilReady(), indexWorker?.waitUntilReady()]);
log.info(
  {
    indexing: github !== null,
    topicNames: describer?.model ?? 'heuristic',
    aiBudgetUsd: env.WAYMARK_LLM_MONTHLY_BUDGET_USD,
  },
  'worker ready',
);

/** The AI that names topics, per WAYMARK_LLM_PROVIDER; `null` means heuristic labels only. */
function topicDescriber(e: typeof env): Describer | null {
  const provider =
    e.WAYMARK_LLM_PROVIDER === 'auto'
      ? e.ANTHROPIC_API_KEY
        ? 'claude'
        : e.OLLAMA_MODEL
          ? 'ollama'
          : 'none'
      : e.WAYMARK_LLM_PROVIDER;
  if (provider === 'claude' && e.ANTHROPIC_API_KEY) {
    return new ClaudeDescriber({
      apiKey: e.ANTHROPIC_API_KEY,
      ...(e.WAYMARK_LLM_MODEL ? { model: e.WAYMARK_LLM_MODEL } : {}),
    });
  }
  if (provider === 'ollama' && e.OLLAMA_MODEL) {
    return new OllamaDescriber({ model: e.OLLAMA_MODEL, baseUrl: e.OLLAMA_URL });
  }
  return null;
}
