import type { PushJob } from '@waymark/core';
import { signGitHubPayload } from '@waymark/core';
import { pushPayload } from '@waymark/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.ts';

const secret = 'test-webhook-secret-123456';

function setup(isReady?: () => Promise<boolean>) {
  const enqueued: PushJob[] = [];
  const enqueuePush = vi.fn(async (job: PushJob) => {
    enqueued.push(job);
    return { jobId: `push-${job.deliveryId}`, status: 'queued' as const };
  });
  const app = buildApp({ webhookSecret: secret, enqueuePush, ...(isReady ? { isReady } : {}) });
  return { app, enqueued, enqueuePush };
}

function deliver(
  app: ReturnType<typeof buildApp>,
  event: string,
  body: unknown,
  opts: { signature?: string | null; delivery?: string | null; raw?: string } = {},
) {
  const raw = opts.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  headers['x-github-event'] = event;
  if (opts.delivery !== null) headers['x-github-delivery'] = opts.delivery ?? 'delivery-123';
  if (opts.signature !== null)
    headers['x-hub-signature-256'] = opts.signature ?? signGitHubPayload(secret, raw);
  return app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: raw });
}

describe('POST /webhooks/github', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('queues a signed push and answers 202', async () => {
    const res = await deliver(ctx.app, 'push', pushPayload());
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'queued', jobId: 'push-delivery-123' });
    expect(ctx.enqueued).toHaveLength(1);
    expect(ctx.enqueued[0]?.repository.fullName).toBe('octo/waymark-demo');
  });

  it('verifies the signature over the exact bytes received (whitespace matters)', async () => {
    const raw = JSON.stringify(pushPayload(), null, 2);
    const res = await deliver(ctx.app, 'push', null, { raw });
    expect(res.statusCode).toBe(202);
  });

  it('rejects a missing signature with 401 and enqueues nothing', async () => {
    const res = await deliver(ctx.app, 'push', pushPayload(), { signature: null });
    expect(res.statusCode).toBe(401);
    expect(ctx.enqueuePush).not.toHaveBeenCalled();
  });

  it('rejects a signature from another secret', async () => {
    const raw = JSON.stringify(pushPayload());
    const res = await deliver(ctx.app, 'push', null, {
      raw,
      signature: signGitHubPayload('wrong-secret-abcdefg', raw),
    });
    expect(res.statusCode).toBe(401);
  });

  it('checks the signature before the headers, so unauthenticated callers learn nothing', async () => {
    const res = await deliver(ctx.app, 'push', pushPayload(), { signature: null, delivery: null });
    expect(res.statusCode).toBe(401);
  });

  it('requires a delivery id on signed requests', async () => {
    const res = await deliver(ctx.app, 'push', pushPayload(), { delivery: null });
    expect(res.statusCode).toBe(400);
  });

  it('answers ping with pong', async () => {
    const res = await deliver(ctx.app, 'ping', { zen: 'Keep it logically awesome.' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'pong' });
  });

  it('acknowledges events it does not handle yet without queueing them', async () => {
    const res = await deliver(ctx.app, 'issues', { action: 'opened' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'ignored', event: 'issues' });
    expect(ctx.enqueuePush).not.toHaveBeenCalled();
  });

  it('skips branch deletions', async () => {
    const res = await deliver(ctx.app, 'push', pushPayload({ deleted: true, commits: [] }));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'skipped', reason: 'branch_deleted' });
  });

  it('returns 400 for a signed body that is not JSON', async () => {
    const res = await deliver(ctx.app, 'push', null, { raw: '{not json' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 422 with issues for a signed but malformed push', async () => {
    const res = await deliver(ctx.app, 'push', { ref: 'refs/heads/main' });
    expect(res.statusCode).toBe(422);
    expect(res.json().issues.length).toBeGreaterThan(0);
  });

  it('rejects the form-encoded webhook format (the App must send application/json)', async () => {
    const raw = 'payload=%7B%7D';
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-hub-signature-256': signGitHubPayload(secret, raw),
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(415);
  });

  it('answers 503 when the queue is unavailable, so the delivery can be redelivered', async () => {
    const app = buildApp({
      webhookSecret: secret,
      enqueuePush: async () => {
        throw new Error('Stream isn\x27t writeable and enableOfflineQueue options is false');
      },
    });
    const res = await deliver(app, 'push', pushPayload());
    expect(res.statusCode).toBe(503);
  });

  it('reports duplicates and requeues as reported by the queue', async () => {
    const app = buildApp({
      webhookSecret: secret,
      enqueuePush: async (job) => ({ jobId: `push-${job.deliveryId}`, status: 'duplicate' }),
    });
    const res = await deliver(app, 'push', pushPayload());
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'duplicate' });
  });

  it('accepts application/json with a charset parameter', async () => {
    const raw = JSON.stringify(pushPayload());
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-github-event': 'push',
        'x-github-delivery': 'd-charset',
        'x-hub-signature-256': signGitHubPayload(secret, raw),
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(202);
  });

  it('rejects a malformed signature header before reading the body', async () => {
    const res = await deliver(ctx.app, 'push', pushPayload(), { signature: 'sha256=nothex' });
    expect(res.statusCode).toBe(401);
    expect(ctx.enqueuePush).not.toHaveBeenCalled();
  });
});

describe('installation events', () => {
  function installApp(enqueueIndex = vi.fn(async () => {})) {
    const app = buildApp({
      webhookSecret: secret,
      enqueuePush: async () => ({ jobId: 'x', status: 'queued' }),
      enqueueIndex,
    });
    return { app, enqueueIndex };
  }

  it('schedules an initial index for every repository of a new installation', async () => {
    const { app, enqueueIndex } = installApp();
    const res = await deliver(app, 'installation', {
      action: 'created',
      installation: { id: 7 },
      repositories: [
        { id: 1, full_name: 'octo/a' },
        { id: 2, full_name: 'octo/b' },
      ],
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'queued', repositories: 2 });
    expect(enqueueIndex).toHaveBeenCalledWith([
      { githubId: 1, fullName: 'octo/a', installationId: 7, sha: null, reason: 'installation' },
      { githubId: 2, fullName: 'octo/b', installationId: 7, sha: null, reason: 'installation' },
    ]);
  });

  it('acknowledges installation actions it does not act on', async () => {
    const { app, enqueueIndex } = installApp();
    const res = await deliver(app, 'installation', { action: 'deleted', installation: { id: 7 } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'skipped' });
    expect(enqueueIndex).not.toHaveBeenCalled();
  });

  it('answers 503 when indexing cannot be scheduled, so GitHub can redeliver', async () => {
    const { app } = installApp(
      vi.fn(async () => {
        throw new Error('redis down');
      }),
    );
    const res = await deliver(app, 'installation_repositories', {
      action: 'added',
      installation: { id: 7 },
      repositories_added: [{ id: 3, full_name: 'octo/c' }],
    });
    expect(res.statusCode).toBe(503);
  });

  it('still requires a valid signature', async () => {
    const { app, enqueueIndex } = installApp();
    const res = await deliver(app, 'installation', { action: 'created' }, { signature: null });
    expect(res.statusCode).toBe(401);
    expect(enqueueIndex).not.toHaveBeenCalled();
  });
});

describe('client IP handling', () => {
  function ipApp(trustProxyHops?: number) {
    const app = buildApp({
      webhookSecret: secret,
      enqueuePush: async () => ({ jobId: 'x', status: 'queued' }),
      ...(trustProxyHops === undefined ? {} : { trustProxyHops }),
    });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    return app;
  }

  it('ignores X-Forwarded-For by default, so clients cannot spoof their logged IP', async () => {
    const res = await ipApp().inject({ url: '/ip', headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(res.json().ip).not.toBe('1.2.3.4');
  });

  it('honours X-Forwarded-For when configured to trust one proxy hop', async () => {
    const res = await ipApp(1).inject({ url: '/ip', headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(res.json().ip).toBe('1.2.3.4');
  });
});

describe('health endpoints', () => {
  it('reports liveness', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('reports 503 when a dependency is down', async () => {
    const { app } = setup(async () => false);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
  });

  it('reports 503 when the readiness check throws', async () => {
    const { app } = setup(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
  });
});
