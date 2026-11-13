import { EnvError, loadServerEnv } from '@waymark/core';
import { createGitHubEventsQueue, createRedisHealthCheck, enqueuePush } from '@waymark/queue';
import { buildApp } from './app.ts';

let env: ReturnType<typeof loadServerEnv>;
try {
  env = loadServerEnv();
} catch (err) {
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const queue = createGitHubEventsQueue(env.REDIS_URL);
const redisHealth = createRedisHealthCheck(env.REDIS_URL);

const app = buildApp({
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  enqueuePush: (job) => enqueuePush(queue, job),
  isReady: redisHealth.isReady,
  logger: { level: env.LOG_LEVEL },
  trustProxyHops: env.TRUST_PROXY_HOPS,
});

// Without a listener, connection errors would be dumped unstructured to stderr.
queue.on('error', (err) => app.log.error({ err }, 'queue connection error'));

/** Upper bound for a graceful stop; orchestrators SIGKILL after ~10–30 s anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  setTimeout(() => {
    app.log.error('graceful shutdown timed out, exiting');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  // Stop accepting requests first, let in-flight enqueues finish, then drop Redis connections.
  await app.close();
  await queue.close();
  await redisHealth.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.PORT, host: env.HOST });
