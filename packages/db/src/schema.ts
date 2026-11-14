import type { FileKind, RepoIndex } from '@waymark/indexer';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`),
};

/** A GitHub repository Waymark has received events for. */
export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    githubId: bigint('github_id', { mode: 'number' }).notNull(),
    fullName: text('full_name').notNull(),
    defaultBranch: text('default_branch').notNull(),
    isPrivate: boolean('is_private').notNull(),
    installationId: bigint('installation_id', { mode: 'number' }),
    /** When Waymark last received a push (server clock), not the commit timestamp. */
    lastPushAt: timestamp('last_push_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('repositories_github_id_key').on(t.githubId)],
);

export interface CommitFiles {
  added: string[];
  removed: string[];
  modified: string[];
}

/**
 * One row per commit SHA per repository. The same SHA arriving again (webhook redelivery, or the
 * commit being pushed to a second branch) is ignored, so ingestion is idempotent.
 */
export const commits = pgTable(
  'commits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    /** Branch the commit was first seen on. */
    branch: text('branch').notNull(),
    message: text('message').notNull(),
    authorName: text('author_name').notNull(),
    authorUsername: text('author_username'),
    committedAt: timestamp('committed_at', { withTimezone: true }).notNull(),
    url: text('url').notNull(),
    files: jsonb('files').$type<CommitFiles>().notNull(),
    /** Populated by the review engine in Phase 2. */
    triage: jsonb('triage'),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('commits_repository_sha_key').on(t.repositoryId, t.sha),
    // "What did I do today / where did I leave off" reads commits newest-first per repository.
    index('commits_repository_committed_at_idx').on(t.repositoryId, t.committedAt.desc()),
  ],
);

/** Everything in an index except the per-file rows, which live in their own tables. */
export type SnapshotSummary = Omit<RepoIndex, 'files' | 'edges'>;

/**
 * The structural index of a repository at one commit: the input the map is drawn from.
 * One row per (repository, commit); re-indexing the same commit is a no-op.
 */
export const repoSnapshots = pgTable(
  'repo_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer('duration_ms').notNull(),
    fileCount: integer('file_count').notNull(),
    edgeCount: integer('edge_count').notNull(),
    /** A size limit stopped indexing early; the map is partial. */
    truncated: boolean('truncated').notNull(),
    summary: jsonb('summary').$type<SnapshotSummary>().notNull(),
    /** When topics were last built for this snapshot; `null` until the first build. */
    topicsBuiltAt: timestamp('topics_built_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('repo_snapshots_repository_sha_key').on(t.repositoryId, t.commitSha),
    index('repo_snapshots_repository_indexed_at_idx').on(t.repositoryId, t.indexedAt.desc()),
  ],
);

export const snapshotFiles = pgTable(
  'snapshot_files',
  {
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => repoSnapshots.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    language: text('language'),
    kind: text('kind').$type<FileKind>().notNull(),
    module: text('module').notNull(),
    size: integer('size').notNull(),
    lines: integer('lines'),
    /** Git blob SHA: compare with the next snapshot to find changed files without diffing content. */
    blobSha: text('blob_sha'),
    /** Exported functions, classes, and types. */
    symbols: jsonb('symbols').$type<string[]>().notNull().default([]),
    /** External packages the file imports. */
    externals: jsonb('externals').$type<string[]>().notNull().default([]),
    /** Stable id of the topic the file belongs to (set when topics are built). */
    topicId: text('topic_id'),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.path] })],
);

/** File-level import graph of a snapshot (`from` imports `to`). */
export const snapshotEdges = pgTable(
  'snapshot_edges',
  {
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => repoSnapshots.id, { onDelete: 'cascade' }),
    fromPath: text('from_path').notNull(),
    toPath: text('to_path').notNull(),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.fromPath, t.toPath] })],
);

/** A topic of one snapshot: the node the map draws. */
export const snapshotTopics = pgTable(
  'snapshot_topics',
  {
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => repoSnapshots.id, { onDelete: 'cascade' }),
    /** Stable across snapshots (see repository_topics). */
    topicId: text('topic_id').notNull(),
    package: text('package').notNull(),
    directory: text('directory').notNull(),
    /** AI name when available, else the heuristic label. */
    name: text('name').notNull(),
    summary: text('summary'),
    role: text('role'),
    /** Where `name` came from: `ai` or `heuristic`. */
    source: text('source').notNull(),
    label: text('label').notNull(),
    fileCount: integer('file_count').notNull(),
    testCount: integer('test_count').notNull(),
    lineCount: integer('line_count').notNull(),
    languages: jsonb('languages').$type<Record<string, number>>().notNull(),
    keywords: jsonb('keywords').$type<string[]>().notNull(),
    externals: jsonb('externals').$type<string[]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.topicId] })],
);

/** Imports between topics of a snapshot. */
export const snapshotTopicEdges = pgTable(
  'snapshot_topic_edges',
  {
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => repoSnapshots.id, { onDelete: 'cascade' }),
    fromTopic: text('from_topic').notNull(),
    toTopic: text('to_topic').notNull(),
    weight: integer('weight').notNull(),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.fromTopic, t.toTopic] })],
);

/**
 * Every topic a repository has had, across snapshots: the memory that keeps topic ids stable and
 * lets an AI description be reused until the topic actually changes.
 */
export const repositoryTopics = pgTable(
  'repository_topics',
  {
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    topicId: text('topic_id').notNull(),
    /** Current member paths. */
    members: jsonb('members').$type<string[]>().notNull(),
    name: text('name'),
    summary: text('summary'),
    role: text('role'),
    provider: text('provider'),
    model: text('model'),
    promptVersion: integer('prompt_version'),
    /** Members and their blob SHAs when the description was written: the baseline for "changed". */
    describedBlobs: jsonb('described_blobs').$type<Record<string, string | null>>(),
    describedAt: timestamp('described_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.repositoryId, t.topicId] })],
);

/** Every paid (or local) model call, for the monthly budget and for transparency. */
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }).notNull(),
  },
  (t) => [index('llm_usage_created_at_idx').on(t.createdAt)],
);

export type Repository = typeof repositories.$inferSelect;
export type Commit = typeof commits.$inferSelect;
export type RepoSnapshot = typeof repoSnapshots.$inferSelect;
