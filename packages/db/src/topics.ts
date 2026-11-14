import { and, asc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from './client.ts';
import { cleanJson, cleanText } from './sanitize.ts';
import {
  llmUsage,
  repoSnapshots,
  repositoryTopics,
  snapshotEdges,
  snapshotFiles,
  snapshotTopicEdges,
  snapshotTopics,
} from './schema.ts';

/** What topic building needs from a stored snapshot. */
export async function loadSnapshotForTopics(db: Database, snapshotId: string) {
  const [snapshot] = await db
    .select({
      id: repoSnapshots.id,
      repositoryId: repoSnapshots.repositoryId,
      summary: repoSnapshots.summary,
      topicsBuiltAt: repoSnapshots.topicsBuiltAt,
    })
    .from(repoSnapshots)
    .where(eq(repoSnapshots.id, snapshotId));
  if (!snapshot) return null;
  const files = await db
    .select({
      path: snapshotFiles.path,
      language: snapshotFiles.language,
      kind: snapshotFiles.kind,
      lines: snapshotFiles.lines,
      blobSha: snapshotFiles.blobSha,
      symbols: snapshotFiles.symbols,
      externals: snapshotFiles.externals,
    })
    .from(snapshotFiles)
    .where(eq(snapshotFiles.snapshotId, snapshotId))
    .orderBy(asc(snapshotFiles.path));
  const edges = await db
    .select({ from: snapshotEdges.fromPath, to: snapshotEdges.toPath })
    .from(snapshotEdges)
    .where(eq(snapshotEdges.snapshotId, snapshotId));
  // Summaries from older indexes may lack fields added since; callers treat them as optional.
  const summary = snapshot.summary as Partial<typeof snapshot.summary>;
  return { ...snapshot, summary, files, edges };
}

export type KnownTopicRow = typeof repositoryTopics.$inferSelect;

export async function loadRepositoryTopics(
  db: Database,
  repositoryId: string,
): Promise<KnownTopicRow[]> {
  return db
    .select()
    .from(repositoryTopics)
    .where(eq(repositoryTopics.repositoryId, repositoryId))
    .orderBy(asc(repositoryTopics.topicId));
}

export interface TopicToSave {
  topicId: string;
  package: string;
  directory: string;
  files: string[];
  label: string;
  keywords: string[];
  externals: string[];
  languages: Record<string, number>;
  sourceFiles: number;
  testFiles: number;
  lines: number;
  /** Description to show: new or reused. */
  description: { name: string; summary: string; role: string } | null;
  /** Set when the description was written in this run: stored as the new baseline. */
  freshDescription: {
    provider: string;
    model: string;
    promptVersion: number;
    blobs: Record<string, string | null>;
  } | null;
}

/** Rows per insert: 16 columns x 500 and 4 x 5,000 stay under the 65,535-parameter limit. */
const TOPIC_CHUNK = 500;
const EDGE_CHUNK = 5_000;
const FILE_UPDATE_CHUNK = 2_000;

/**
 * Stores the topics of a snapshot in one transaction: replaces any previous build for the snapshot,
 * labels its files, and updates the repository's topic memory. Idempotent.
 */
export async function saveTopics(
  db: Database,
  snapshotId: string,
  repositoryId: string,
  topics: TopicToSave[],
  edges: { from: string; to: string; weight: number }[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(snapshotTopicEdges).where(eq(snapshotTopicEdges.snapshotId, snapshotId));
    await tx.delete(snapshotTopics).where(eq(snapshotTopics.snapshotId, snapshotId));

    const rows = topics.map((t) =>
      cleanJson({
        snapshotId,
        topicId: t.topicId,
        package: t.package,
        directory: t.directory,
        name: t.description?.name ?? t.label,
        summary: t.description?.summary ?? null,
        role: t.description?.role ?? null,
        source: t.description ? 'ai' : 'heuristic',
        label: t.label,
        fileCount: t.sourceFiles,
        testCount: t.testFiles,
        lineCount: t.lines,
        languages: t.languages,
        keywords: t.keywords,
        externals: t.externals,
      }),
    );
    for (let i = 0; i < rows.length; i += TOPIC_CHUNK) {
      await tx.insert(snapshotTopics).values(rows.slice(i, i + TOPIC_CHUNK));
    }
    for (let i = 0; i < edges.length; i += EDGE_CHUNK) {
      await tx.insert(snapshotTopicEdges).values(
        edges.slice(i, i + EDGE_CHUNK).map((e) => ({
          snapshotId,
          fromTopic: e.from,
          toTopic: e.to,
          weight: e.weight,
        })),
      );
    }

    // Label files with their topic: one UPDATE … FROM (VALUES …) per chunk.
    await tx
      .update(snapshotFiles)
      .set({ topicId: null })
      .where(eq(snapshotFiles.snapshotId, snapshotId));
    const assignments = topics.flatMap((t) => t.files.map((path) => [path, t.topicId] as const));
    for (let i = 0; i < assignments.length; i += FILE_UPDATE_CHUNK) {
      const values = sql.join(
        assignments
          .slice(i, i + FILE_UPDATE_CHUNK)
          .map(([path, topic]) => sql`(${path}::text, ${topic}::text)`),
        sql`, `,
      );
      await tx.execute(sql`
        update ${snapshotFiles} as f set topic_id = v.topic
        from (values ${values}) as v(path, topic)
        where f.snapshot_id = ${snapshotId} and f.path = v.path`);
    }

    // Multi-row upserts in a fixed order (by topic id): fewer round trips, and two builds can
    // never take the same row locks in opposite order.
    const sorted = [...topics].sort((a, b) =>
      a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0,
    );
    const fresh = sorted.filter((t) => t.freshDescription && t.description);
    const plain = sorted.filter((t) => !(t.freshDescription && t.description));
    for (let i = 0; i < plain.length; i += TOPIC_CHUNK) {
      await tx
        .insert(repositoryTopics)
        .values(
          plain
            .slice(i, i + TOPIC_CHUNK)
            .map((t) => ({ repositoryId, topicId: t.topicId, members: t.files })),
        )
        .onConflictDoUpdate({
          target: [repositoryTopics.repositoryId, repositoryTopics.topicId],
          set: { members: sql`excluded.members`, lastSeenAt: sql`now()` },
        });
    }
    for (let i = 0; i < fresh.length; i += TOPIC_CHUNK) {
      await tx
        .insert(repositoryTopics)
        .values(
          fresh.slice(i, i + TOPIC_CHUNK).map((t) => {
            const d = t.description as NonNullable<TopicToSave['description']>;
            const f = t.freshDescription as NonNullable<TopicToSave['freshDescription']>;
            return {
              repositoryId,
              topicId: t.topicId,
              members: t.files,
              name: cleanText(d.name),
              summary: cleanText(d.summary),
              role: d.role,
              provider: f.provider,
              model: f.model,
              promptVersion: f.promptVersion,
              describedBlobs: f.blobs,
              describedAt: new Date(),
            };
          }),
        )
        .onConflictDoUpdate({
          target: [repositoryTopics.repositoryId, repositoryTopics.topicId],
          set: {
            members: sql`excluded.members`,
            name: sql`excluded.name`,
            summary: sql`excluded.summary`,
            role: sql`excluded.role`,
            provider: sql`excluded.provider`,
            model: sql`excluded.model`,
            promptVersion: sql`excluded.prompt_version`,
            describedBlobs: sql`excluded.described_blobs`,
            describedAt: sql`now()`,
            lastSeenAt: sql`now()`,
          },
        });
    }

    await tx
      .update(repoSnapshots)
      .set({ topicsBuiltAt: sql`now()` })
      .where(eq(repoSnapshots.id, snapshotId));
  });
}

/**
 * Runs `fn` while holding a Postgres advisory lock named `key`, across every worker process.
 * The lock lives in a transaction on its own connection and is released when `fn` settles, even
 * if the process dies (the connection closes).
 */
export async function withAdvisoryLock<T>(
  db: Database,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return fn();
  });
}

/** Forgets topics a repository has not had for 90 days. */
export async function pruneRepositoryTopics(db: Database, repositoryId: string): Promise<number> {
  const removed = await db
    .delete(repositoryTopics)
    .where(
      and(
        eq(repositoryTopics.repositoryId, repositoryId),
        sql`${repositoryTopics.lastSeenAt} < now() - interval '90 days'`,
      ),
    )
    .returning({ id: repositoryTopics.topicId });
  return removed.length;
}

/** The monthly spending ledger behind the AI budget cap, shared by every worker. */
export function databaseLedger(db: Database, repositoryId: string | null = null) {
  return {
    async spentThisMonthUsd(): Promise<number> {
      const [row] = await db
        .select({ total: sql<string>`coalesce(sum(${llmUsage.costUsd}), 0)` })
        .from(llmUsage)
        .where(gte(llmUsage.createdAt, sql`date_trunc('month', now())`));
      return Number(row?.total ?? 0);
    },
    async record(entry: {
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    }): Promise<void> {
      await db.insert(llmUsage).values({ repositoryId, ...entry });
    },
  };
}

/** Topics and edges of a snapshot, for readers (dashboard, MCP). */
export async function snapshotTopicGraph(db: Database, snapshotId: string) {
  const topics = await db
    .select()
    .from(snapshotTopics)
    .where(eq(snapshotTopics.snapshotId, snapshotId))
    .orderBy(asc(snapshotTopics.package), asc(snapshotTopics.name));
  const edges = await db
    .select()
    .from(snapshotTopicEdges)
    .where(eq(snapshotTopicEdges.snapshotId, snapshotId));
  return { topics, edges };
}
