/**
 * Read models for the dashboard. Everything here is read-only and bounded: a page never loads more
 * than one snapshot's topics plus a window of recent commits.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from './client.ts';
import {
  commits,
  repoSnapshots,
  repositories,
  snapshotFiles,
  snapshotTopicEdges,
  snapshotTopics,
} from './schema.ts';

/** How far back "recent activity" looks. */
export const ACTIVITY_WINDOW_DAYS = 30;
const RECENT_COMMIT_LIMIT = 2_000;
/** Files listed in a topic's side panel; the full count is reported separately. */
export const TOPIC_FILE_LIMIT = 500;

export interface RepositoryCard {
  id: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  lastPushAt: Date | null;
  snapshot: {
    id: string;
    commitSha: string;
    indexedAt: Date;
    fileCount: number;
    topicCount: number;
    markerCount: number;
    frameworks: string[];
    languages: { name: string; lines: number }[];
    truncated: boolean;
  } | null;
  commits7d: number;
  /** Most recently changed topics (by name), newest first. */
  activeTopics: string[];
}

/** The latest snapshot of a repository that has topics, else its latest snapshot. */
async function latestSnapshots(db: Database, repositoryIds: string[]) {
  if (repositoryIds.length === 0) return new Map<string, typeof repoSnapshots.$inferSelect>();
  const rows = await db
    .selectDistinctOn([repoSnapshots.repositoryId])
    .from(repoSnapshots)
    .where(inArray(repoSnapshots.repositoryId, repositoryIds))
    .orderBy(
      repoSnapshots.repositoryId,
      sql`${repoSnapshots.topicsBuiltAt} is null`,
      desc(repoSnapshots.indexedAt),
    );
  return new Map(rows.map((r) => [r.repositoryId, r]));
}

/** Recent commits of a repository with the topic each touched file belongs to in `snapshotId`. */
async function recentActivity(
  db: Database,
  repositoryId: string,
  snapshotId: string,
  options: { topicId?: string; limit?: number } = {},
) {
  const since = sql`now() - make_interval(days => ${ACTIVITY_WINDOW_DAYS})`;
  // Paths → topics in Postgres (primary-key lookups per path), so a commit touching thousands of
  // files never ships its file list to the app.
  const topicsOfCommit = sql<string[]>`array(
    select distinct sf.topic_id
    from jsonb_array_elements_text(
      ("commits"."files"->'added') || ("commits"."files"->'modified') || ("commits"."files"->'removed')
    ) as p(path)
    join ${snapshotFiles} sf on sf.snapshot_id = ${snapshotId} and sf.path = p.path
    where sf.topic_id is not null
    order by sf.topic_id
  )`;
  const rows = await db
    .select({
      sha: commits.sha,
      message: commits.message,
      authorName: commits.authorName,
      committedAt: commits.committedAt,
      ingestedAt: commits.ingestedAt,
      topics: topicsOfCommit,
    })
    .from(commits)
    .where(
      and(
        eq(commits.repositoryId, repositoryId),
        gte(commits.ingestedAt, since),
        options.topicId === undefined
          ? undefined
          : sql`${options.topicId} = any(${topicsOfCommit})`,
      ),
    )
    .orderBy(desc(commits.ingestedAt))
    .limit(options.limit ?? RECENT_COMMIT_LIMIT);
  return rows.map((r) => ({ ...r, topics: r.topics ?? [] }));
}

export type RecentCommit = Awaited<ReturnType<typeof recentActivity>>[number];

export async function listRepositoryCards(db: Database): Promise<RepositoryCard[]> {
  // Most recently pushed first; never-pushed (e.g. just installed) last.
  const repos = await db
    .select()
    .from(repositories)
    .orderBy(sql`${repositories.lastPushAt} desc nulls last`, repositories.fullName);
  const snapshots = await latestSnapshots(
    db,
    repos.map((r) => r.id),
  );
  const cards: RepositoryCard[] = [];
  for (const repo of repos) {
    const snap = snapshots.get(repo.id);
    let topicCount = 0;
    let activeTopics: string[] = [];
    let commits7d = 0;
    if (snap) {
      const [count] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(snapshotTopics)
        .where(eq(snapshotTopics.snapshotId, snap.id));
      topicCount = count?.n ?? 0;
      const activity = await recentActivity(db, repo.id, snap.id);
      const weekAgo = Date.now() - 7 * 86_400_000;
      commits7d = activity.filter((c) => c.ingestedAt.getTime() >= weekAgo).length;
      const recentTopicIds = [...new Set(activity.flatMap((c) => c.topics))].slice(0, 5);
      if (recentTopicIds.length > 0) {
        const names = await db
          .select({ id: snapshotTopics.topicId, name: snapshotTopics.name })
          .from(snapshotTopics)
          .where(
            and(
              eq(snapshotTopics.snapshotId, snap.id),
              inArray(snapshotTopics.topicId, recentTopicIds),
            ),
          );
        const byId = new Map(names.map((n) => [n.id, n.name]));
        activeTopics = recentTopicIds.map((id) => byId.get(id)).filter((n): n is string => !!n);
      }
    }
    const summary = snap?.summary;
    cards.push({
      id: repo.id,
      fullName: repo.fullName,
      isPrivate: repo.isPrivate,
      defaultBranch: repo.defaultBranch,
      lastPushAt: repo.lastPushAt,
      snapshot: snap
        ? {
            id: snap.id,
            commitSha: snap.commitSha,
            indexedAt: snap.indexedAt,
            fileCount: snap.fileCount,
            topicCount,
            markerCount: summary?.markers?.length ?? 0,
            frameworks: summary?.frameworks ?? [],
            languages: Object.entries(summary?.stats?.languages ?? {})
              .map(([name, s]) => ({ name, lines: s.lines }))
              .sort((a, b) => b.lines - a.lines)
              .slice(0, 4),
            truncated: snap.truncated,
          }
        : null,
      commits7d,
      activeTopics,
    });
  }
  return cards;
}

export interface MapTopic {
  id: string;
  package: string;
  directory: string;
  name: string;
  summary: string | null;
  role: string | null;
  source: string;
  fileCount: number;
  testCount: number;
  lineCount: number;
  languages: Record<string, number>;
  externals: string[];
  markerCount: number;
  /** Ingest time of the newest commit that touched the topic within the activity window. */
  lastChangedAt: string | null;
  commits30d: number;
}

export interface RepositoryMap {
  repository: { id: string; fullName: string; defaultBranch: string; isPrivate: boolean };
  snapshot: {
    id: string;
    commitSha: string;
    indexedAt: string;
    fileCount: number;
    truncated: boolean;
  };
  packages: { id: string; name: string | null; description: string | null }[];
  topics: MapTopic[];
  edges: { from: string; to: string; weight: number }[];
}

export async function findRepository(db: Database, fullName: string) {
  const [repo] = await db
    .select()
    .from(repositories)
    .where(sql`lower(${repositories.fullName}) = lower(${fullName})`)
    .limit(1);
  return repo ?? null;
}

/** Everything the map page draws, for the repository's latest snapshot with topics. */
export async function repositoryMap(db: Database, fullName: string): Promise<RepositoryMap | null> {
  const repo = await findRepository(db, fullName);
  if (!repo) return null;
  const snap = (await latestSnapshots(db, [repo.id])).get(repo.id);
  if (!snap) return null;

  const topics = await db
    .select()
    .from(snapshotTopics)
    .where(eq(snapshotTopics.snapshotId, snap.id));
  const edges = await db
    .select({
      from: snapshotTopicEdges.fromTopic,
      to: snapshotTopicEdges.toTopic,
      weight: snapshotTopicEdges.weight,
    })
    .from(snapshotTopicEdges)
    .where(eq(snapshotTopicEdges.snapshotId, snap.id));

  // Markers per topic: markers carry paths; files carry topics.
  const markers = snap.summary.markers ?? [];
  const markerTopic = new Map<string, number>();
  if (markers.length > 0) {
    const rows = await db
      .select({ path: snapshotFiles.path, topicId: snapshotFiles.topicId })
      .from(snapshotFiles)
      .where(
        and(
          eq(snapshotFiles.snapshotId, snap.id),
          inArray(snapshotFiles.path, [...new Set(markers.map((m) => m.path))]),
        ),
      );
    const topicOfPath = new Map(rows.map((r) => [r.path, r.topicId]));
    for (const m of markers) {
      const t = topicOfPath.get(m.path);
      if (t) markerTopic.set(t, (markerTopic.get(t) ?? 0) + 1);
    }
  }

  const activity = await recentActivity(db, repo.id, snap.id);
  const lastChanged = new Map<string, Date>();
  const commitCount = new Map<string, number>();
  for (const c of activity) {
    for (const t of c.topics) {
      if (!lastChanged.has(t)) lastChanged.set(t, c.ingestedAt); // newest first
      commitCount.set(t, (commitCount.get(t) ?? 0) + 1);
    }
  }

  const manifests = snap.summary.manifests ?? [];
  const packageIds = [...new Set(topics.map((t) => t.package))].sort();
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  return {
    repository: {
      id: repo.id,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      isPrivate: repo.isPrivate,
    },
    snapshot: {
      id: snap.id,
      commitSha: snap.commitSha,
      indexedAt: snap.indexedAt.toISOString(),
      fileCount: snap.fileCount,
      truncated: snap.truncated,
    },
    packages: packageIds.map((id) => {
      const m = manifests.find(
        (x) =>
          dirOf(x.path) === id &&
          /package\.json$|pyproject\.toml$|go\.mod$|Cargo\.toml$/.test(x.path),
      );
      return { id, name: m?.name ?? null, description: m?.description ?? null };
    }),
    topics: topics.map((t) => ({
      id: t.topicId,
      package: t.package,
      directory: t.directory,
      name: t.name,
      summary: t.summary,
      role: t.role,
      source: t.source,
      fileCount: t.fileCount,
      testCount: t.testCount,
      lineCount: t.lineCount,
      languages: t.languages,
      externals: t.externals,
      markerCount: markerTopic.get(t.topicId) ?? 0,
      lastChangedAt: lastChanged.get(t.topicId)?.toISOString() ?? null,
      commits30d: commitCount.get(t.topicId) ?? 0,
    })),
    edges,
  };
}

export interface TopicDetail {
  /** Every file of the topic; `files` holds at most `TOPIC_FILE_LIMIT` of them. */
  fileCount: number;
  files: {
    path: string;
    language: string | null;
    kind: string;
    lines: number | null;
    symbols: string[];
  }[];
  markers: { path: string; line: number; kind: string; text: string }[];
  commits: { sha: string; message: string; authorName: string; at: string }[];
}

/** The side panel for one topic: its files, TODOs, and the recent commits that touched it. */
export async function topicDetail(
  db: Database,
  repositoryId: string,
  snapshotId: string,
  topicId: string,
): Promise<TopicDetail | null> {
  const [snap] = await db
    .select({ summary: repoSnapshots.summary })
    .from(repoSnapshots)
    .where(and(eq(repoSnapshots.id, snapshotId), eq(repoSnapshots.repositoryId, repositoryId)));
  // A snapshot of another repository: nothing to show rather than a mix of two.
  if (!snap) return null;

  const inTopic = and(eq(snapshotFiles.snapshotId, snapshotId), eq(snapshotFiles.topicId, topicId));
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(snapshotFiles)
    .where(inTopic);
  const files = await db
    .select({
      path: snapshotFiles.path,
      language: snapshotFiles.language,
      kind: snapshotFiles.kind,
      lines: snapshotFiles.lines,
      symbols: snapshotFiles.symbols,
    })
    .from(snapshotFiles)
    .where(inTopic)
    .orderBy(snapshotFiles.path)
    .limit(TOPIC_FILE_LIMIT);

  // Markers by the topic of their file, not by the listed files: a 2,000-file topic keeps its TODOs.
  const allMarkers = snap.summary.markers ?? [];
  let markers: TopicDetail['markers'] = [];
  if (allMarkers.length > 0) {
    const markerPaths = await db
      .select({ path: snapshotFiles.path })
      .from(snapshotFiles)
      .where(
        and(inTopic, inArray(snapshotFiles.path, [...new Set(allMarkers.map((m) => m.path))])),
      );
    const paths = new Set(markerPaths.map((r) => r.path));
    markers = allMarkers.filter((m) => paths.has(m.path)).slice(0, 100);
  }

  const touching = (await recentActivity(db, repositoryId, snapshotId, { topicId, limit: 20 })).map(
    (c) => ({
      sha: c.sha,
      message: c.message.split('\n')[0] ?? '',
      authorName: c.authorName,
      at: c.ingestedAt.toISOString(),
    }),
  );

  return { fileCount: count?.n ?? files.length, files, markers, commits: touching };
}
