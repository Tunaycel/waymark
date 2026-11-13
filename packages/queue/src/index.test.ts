import type { PushJob } from '@waymark/core';
import { describe, expect, it } from 'vitest';
import {
  EnqueueTimeoutError,
  enqueuePush,
  type GitHubEventJob,
  jobIdForDelivery,
  type Queue,
} from './index.ts';

const job = { deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958' } as PushJob;

/** Minimal stand-in for the BullMQ calls enqueuePush makes. */
function fakeQueue(existing: null | { failed: boolean; retry?: () => Promise<void> }) {
  const added: string[] = [];
  const queue = {
    getJob: async () =>
      existing && {
        isFailed: async () => existing.failed,
        retry: existing.retry ?? (async () => {}),
      },
    add: async (_name: string, _data: GitHubEventJob, opts: { jobId: string }) => {
      added.push(opts.jobId);
      return { id: opts.jobId };
    },
  };
  return { queue: queue as unknown as Queue<GitHubEventJob>, added };
}

describe('jobIdForDelivery', () => {
  it('is deterministic and free of ":" (forbidden by BullMQ)', () => {
    const id = jobIdForDelivery('push', job.deliveryId);
    expect(id).toBe(`push-${job.deliveryId}`);
    expect(id).not.toContain(':');
  });
});

describe('enqueuePush', () => {
  it('queues a new delivery', async () => {
    const { queue, added } = fakeQueue(null);
    expect(await enqueuePush(queue, job)).toEqual({
      jobId: `push-${job.deliveryId}`,
      status: 'queued',
    });
    expect(added).toHaveLength(1);
  });

  it('treats a redelivery of a pending or finished job as a duplicate', async () => {
    const { queue, added } = fakeQueue({ failed: false });
    expect((await enqueuePush(queue, job)).status).toBe('duplicate');
    expect(added).toHaveLength(0);
  });

  it('requeues a redelivery of a job that exhausted its retries', async () => {
    let retried = false;
    const { queue } = fakeQueue({
      failed: true,
      retry: async () => {
        retried = true;
      },
    });
    expect((await enqueuePush(queue, job)).status).toBe('requeued');
    expect(retried).toBe(true);
  });

  it('reports a duplicate if a concurrent redelivery already requeued the job', async () => {
    const { queue } = fakeQueue({
      failed: true,
      retry: async () => {
        throw new Error('Job is not in the failed state');
      },
    });
    expect((await enqueuePush(queue, job)).status).toBe('duplicate');
  });

  it('gives up after the timeout instead of hanging the webhook request', async () => {
    const queue = { getJob: () => new Promise(() => {}) } as unknown as Queue<GitHubEventJob>;
    const started = Date.now();
    await expect(enqueuePush(queue, job, 50)).rejects.toBeInstanceOf(EnqueueTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
