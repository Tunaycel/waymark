import {
  type PushJob,
  parseInstallationEvent,
  parsePushEvent,
  verifyGitHubSignature,
} from '@waymark/core';
import type { EnqueueOutcome, IndexJob } from '@waymark/queue';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export interface AppDeps {
  webhookSecret: string;
  /** Hands a normalized push to the queue. Injected so the HTTP layer is testable without Redis. */
  enqueuePush: (job: PushJob) => Promise<EnqueueOutcome>;
  /** Schedules initial indexing for repositories the App was just given access to. */
  enqueueIndex?: (jobs: IndexJob[]) => Promise<void>;
  /** Readiness probe for downstream dependencies (Redis). */
  isReady?: () => Promise<boolean>;
  logger?: FastifyServerOptions['logger'];
  /**
   * Trust X-Forwarded-* headers from this many proxy hops (0 = none). Only enable behind a proxy
   * you control; otherwise any client can spoof the IP that appears in logs.
   */
  trustProxyHops?: number;
}

/** GitHub caps webhook payloads at 25 MB. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const WEBHOOK_PATH = '/webhooks/github';
const SIGNATURE_HEADER = /^sha256=[0-9a-f]{64}$/i;

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: (_address: string, hop: number) => hop < (deps.trustProxyHops ?? 0),
  });

  // Keep the raw bytes: the HMAC signature is computed over them, not over re-serialized JSON.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const ready = deps.isReady ? await deps.isReady().catch(() => false) : true;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unavailable' });
  });

  app.post(
    WEBHOOK_PATH,
    {
      // Runs before the body is read: requests that can't possibly be authentic are rejected
      // without buffering up to 25 MB of attacker-controlled data.
      onRequest: async (req, reply) => {
        if (!SIGNATURE_HEADER.test(header(req.headers['x-hub-signature-256']) ?? '')) {
          return reply.code(401).send({ error: 'invalid signature' });
        }
      },
    },
    async (req, reply) => {
      const event = header(req.headers['x-github-event']);
      const deliveryId = header(req.headers['x-github-delivery']);
      const signature = header(req.headers['x-hub-signature-256']);
      const raw = req.body;

      if (!Buffer.isBuffer(raw)) {
        return reply.code(415).send({ error: 'content-type must be application/json' });
      }
      // Verify before reading anything else, so unauthenticated callers learn nothing.
      if (!verifyGitHubSignature(deps.webhookSecret, raw, signature)) {
        req.log.warn({ deliveryId }, 'rejected webhook with invalid signature');
        return reply.code(401).send({ error: 'invalid signature' });
      }
      if (!event || !deliveryId) {
        return reply
          .code(400)
          .send({ error: 'missing X-GitHub-Event or X-GitHub-Delivery header' });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'body is not valid JSON' });
      }

      if (event === 'ping') return reply.code(200).send({ status: 'pong' });

      if (
        (event === 'installation' || event === 'installation_repositories') &&
        deps.enqueueIndex
      ) {
        const parsed = parseInstallationEvent(event, payload);
        if (parsed.kind === 'skip') {
          return reply.code(202).send({ status: 'skipped', reason: parsed.reason });
        }
        const jobs: IndexJob[] = parsed.repositories.map((r) => ({
          githubId: r.githubId,
          fullName: r.fullName,
          installationId: parsed.installationId,
          sha: null,
          reason: 'installation',
        }));
        try {
          await deps.enqueueIndex(jobs);
        } catch (err) {
          req.log.error({ err, deliveryId }, 'failed to enqueue initial indexing');
          return reply.code(503).send({ error: 'queue unavailable, redeliver later' });
        }
        req.log.info({ deliveryId, repositories: jobs.length }, 'initial indexing scheduled');
        return reply.code(202).send({ status: 'queued', repositories: jobs.length });
      }

      if (event !== 'push') {
        // Acknowledge so GitHub doesn't mark the delivery failed; we just don't use it yet.
        return reply.code(202).send({ status: 'ignored', event });
      }

      const parsed = parsePushEvent(deliveryId, payload);
      switch (parsed.kind) {
        case 'invalid':
          req.log.warn({ deliveryId, issues: parsed.issues }, 'push payload failed validation');
          return reply.code(422).send({ error: 'unexpected push payload', issues: parsed.issues });
        case 'skip':
          return reply.code(202).send({ status: 'skipped', reason: parsed.reason });
        case 'commits': {
          let outcome: EnqueueOutcome;
          try {
            outcome = await deps.enqueuePush(parsed.job);
          } catch (err) {
            // Queue unavailable. 503 makes the failure visible in GitHub's delivery log, where it
            // can be redelivered once Redis is back.
            req.log.error({ err, deliveryId }, 'failed to enqueue push');
            return reply.code(503).send({ error: 'queue unavailable, redeliver later' });
          }
          req.log.info(
            {
              deliveryId,
              repo: parsed.job.repository.fullName,
              commits: parsed.job.commits.length,
              status: outcome.status,
            },
            'push accepted',
          );
          return reply.code(202).send(outcome);
        }
      }
    },
  );

  return app;
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
