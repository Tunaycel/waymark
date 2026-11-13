import { z } from 'zod';

/**
 * The subset of GitHub's `push` webhook payload Waymark relies on.
 * Unknown fields are ignored, so GitHub adding fields never breaks ingestion.
 * Reference: https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
 */
const commitSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'commit id must be a SHA-1 or SHA-256 hex'),
  message: z.string(),
  timestamp: z.iso.datetime({ offset: true }),
  url: z.url(),
  distinct: z.boolean().optional(),
  author: z.object({
    name: z.string(),
    username: z.string().optional(),
  }),
  added: z.array(z.string()).default([]),
  removed: z.array(z.string()).default([]),
  modified: z.array(z.string()).default([]),
});

const pushPayloadSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  deleted: z.boolean().default(false),
  forced: z.boolean().default(false),
  repository: z.object({
    id: z.number().int().positive(),
    full_name: z.string().min(1),
    private: z.boolean(),
    default_branch: z.string().min(1),
  }),
  installation: z.object({ id: z.number().int().positive() }).optional(),
  commits: z.array(commitSchema).default([]),
});

export interface NormalizedCommit {
  sha: string;
  message: string;
  authorName: string;
  authorUsername: string | null;
  committedAt: string;
  url: string;
  files: { added: string[]; removed: string[]; modified: string[] };
}

/** Compact, transport-friendly representation of a push, carried through the queue. */
export interface PushJob {
  deliveryId: string;
  /**
   * When Waymark received the delivery (ISO-8601, server clock). Commit timestamps come from the
   * author's machine and can be wrong or old, so "when did I last work here" uses this instead.
   */
  receivedAt: string;
  installationId: number | null;
  repository: {
    githubId: number;
    fullName: string;
    defaultBranch: string;
    isPrivate: boolean;
  };
  branch: string;
  forced: boolean;
  commits: NormalizedCommit[];
}

export type PushParseResult =
  | { kind: 'commits'; job: PushJob }
  | { kind: 'skip'; reason: 'branch_deleted' | 'not_a_branch' | 'no_commits' }
  | { kind: 'invalid'; issues: string[] };

const BRANCH_PREFIX = 'refs/heads/';

export function parsePushEvent(
  deliveryId: string,
  payload: unknown,
  receivedAt: Date = new Date(),
): PushParseResult {
  const parsed = pushPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const p = parsed.data;

  if (!p.ref.startsWith(BRANCH_PREFIX)) return { kind: 'skip', reason: 'not_a_branch' };
  if (p.deleted) return { kind: 'skip', reason: 'branch_deleted' };
  if (p.commits.length === 0) return { kind: 'skip', reason: 'no_commits' };

  return {
    kind: 'commits',
    job: {
      deliveryId,
      receivedAt: receivedAt.toISOString(),
      installationId: p.installation?.id ?? null,
      repository: {
        githubId: p.repository.id,
        fullName: p.repository.full_name,
        defaultBranch: p.repository.default_branch,
        isPrivate: p.repository.private,
      },
      branch: p.ref.slice(BRANCH_PREFIX.length),
      forced: p.forced,
      commits: p.commits.map((c) => ({
        sha: c.id,
        message: c.message,
        authorName: c.author.name,
        authorUsername: c.author.username ?? null,
        committedAt: c.timestamp,
        url: c.url,
        files: { added: c.added, removed: c.removed, modified: c.modified },
      })),
    },
  };
}
