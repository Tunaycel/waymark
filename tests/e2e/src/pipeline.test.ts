import { signGitHubPayload } from '@waymark/core';
import { pushPayload } from '@waymark/core/testing';
import { commits, type DatabaseHandle, repositories } from '@waymark/db';
import {
  createGitHubEventsQueue,
  createGitHubEventsWorker,
  defaultJobOptions,
  enqueuePush,
  type GitHubEventJob,
  type Queue,
  type Worker,
} from '@waymark/queue';
import { buildApp } from '@waymark/server';
import { createProcessor } from '@waymark/worker';
import { count } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, REDIS_URL, waitFor } from './helpers.ts';

const secret = 'pipeline-test-secret-0123';
const silent = pino({ level: 'silent' });

function signedDelivery(app: ReturnType<typeof buildApp>, body: unknown, deliveryId: string) {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signGitHubPayload(secret, raw),
    },
    payload: raw,
  });
}

/** Isolates each suite's Redis keys so parallel CI jobs or a developer's local data never collide. */
const uniquePrefix = (name: string) => `waymark-test-${name}-${process.pid}-${Date.now()}`;

/**
 * Full path a real GitHub delivery takes:
 *   signed HTTP request → Fastify → BullMQ (Redis) → worker → Postgres
 */
describe('webhook → queue → worker → database', () => {
  let handle: DatabaseHandle;
  let queue: Queue<GitHubEventJob>;
  let worker: Worker<GitHubEventJob>;
  let app: ReturnType<typeof buildApp>;
  const prefix = uniquePrefix('pipeline');

  beforeAll(async () => {
    queue = createGitHubEventsQueue(REDIS_URL, { prefix });
    app = buildApp({ webhookSecret: secret, enqueuePush: (job) => enqueuePush(queue, job) });
  });

  beforeEach(async () => {
    await worker?.close();
    await handle?.close();
    await queue.obliterate({ force: true });
    handle = await freshDatabase();
    worker = createGitHubEventsWorker(REDIS_URL, createProcessor(handle.db, silent), { prefix });
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await app?.close();
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => {});
    await queue?.close();
    await handle?.close();
  });

  const commitTotal = async () => (await handle.db.select({ n: count() }).from(commits))[0]?.n ?? 0;
  const completed = (jobId: string) =>
    waitFor(async () => ((await (await queue.getJob(jobId))?.isCompleted()) ? true : undefined));

  it('persists a delivered push', async () => {
    const res = await signedDelivery(app, pushPayload(), 'delivery-a');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ jobId: 'push-delivery-a', status: 'queued' });

    await completed('push-delivery-a');
    expect(await commitTotal()).toBe(1);
    const [repo] = await handle.db.select().from(repositories);
    expect(repo?.fullName).toBe('octo/waymark-demo');
  });

  it('deduplicates a redelivery with the same delivery id at the queue', async () => {
    await signedDelivery(app, pushPayload(), 'delivery-b');
    const again = await signedDelivery(app, pushPayload(), 'delivery-b');

    expect(again.json()).toMatchObject({ status: 'duplicate' });
    expect(await queue.getJobCountByTypes('completed', 'waiting', 'active', 'delayed')).toBe(1);
  });

  it('does not duplicate commits when GitHub sends a new delivery for the same commits', async () => {
    await signedDelivery(app, pushPayload(), 'delivery-c1');
    await signedDelivery(app, pushPayload(), 'delivery-c2');
    await completed('push-delivery-c1');
    await completed('push-delivery-c2');
    expect(await commitTotal()).toBe(1);
  });
});

describe('recovery: redelivering a delivery whose job failed permanently', () => {
  it('requeues the failed job and then succeeds', async () => {
    const handle = await freshDatabase();
    const prefix = uniquePrefix('recovery');
    // One attempt only, so the first failure is permanent.
    const queue = createGitHubEventsQueue(REDIS_URL, {
      prefix,
      defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
    });
    const app = buildApp({ webhookSecret: secret, enqueuePush: (job) => enqueuePush(queue, job) });

    let databaseDown = true; // simulates an outage during the first attempt
    const real = createProcessor(handle.db, silent);
    const worker = createGitHubEventsWorker(
      REDIS_URL,
      async (job) => {
        if (databaseDown) throw new Error('ECONNREFUSED (simulated)');
        return real(job);
      },
      { prefix },
    );

    try {
      await signedDelivery(app, pushPayload(), 'delivery-r');
      await waitFor(async () =>
        (await (await queue.getJob('push-delivery-r'))?.isFailed()) ? true : undefined,
      );

      databaseDown = false;
      const redelivery = await signedDelivery(app, pushPayload(), 'delivery-r');
      expect(redelivery.json()).toMatchObject({ status: 'requeued' });

      await waitFor(async () =>
        (await (await queue.getJob('push-delivery-r'))?.isCompleted()) ? true : undefined,
      );
      const [row] = await handle.db.select({ n: count() }).from(commits);
      expect(row?.n).toBe(1);
    } finally {
      await app.close();
      await worker.close();
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
      await handle.close();
    }
  });
});

describe('Redis unavailable', () => {
  it('answers 503 within seconds instead of hanging past GitHub’s 10 s timeout', async () => {
    // Port 1 is reserved and closed: connections are refused immediately.
    const queue = createGitHubEventsQueue('redis://127.0.0.1:1', {
      prefix: uniquePrefix('down'),
    });
    queue.on('error', () => {});
    const app = buildApp({ webhookSecret: secret, enqueuePush: (job) => enqueuePush(queue, job) });

    try {
      const started = Date.now();
      const res = await signedDelivery(app, pushPayload(), 'delivery-down');
      const elapsed = Date.now() - started;

      expect(res.statusCode).toBe(503);
      expect(elapsed).toBeLessThan(6_000);
    } finally {
      await app.close();
      await queue.close().catch(() => {});
    }
  });
});
