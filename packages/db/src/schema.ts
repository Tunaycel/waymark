import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
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

export type Repository = typeof repositories.$inferSelect;
export type Commit = typeof commits.$inferSelect;
