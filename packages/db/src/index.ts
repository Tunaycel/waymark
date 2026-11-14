export { createDatabase, type Database, type DatabaseHandle } from './client.ts';
export {
  ACTIVITY_WINDOW_DAYS,
  findRepository,
  listRepositoryCards,
  type MapTopic,
  type RecentCommit,
  type RepositoryCard,
  type RepositoryMap,
  repositoryMap,
  type TopicDetail,
  topicDetail,
} from './dashboard.ts';
export { type IngestResult, ingestPush } from './ingest.ts';
export { migrationsFolder, runMigrations } from './migrate.ts';
export * from './schema.ts';
export {
  findSnapshot,
  hasSnapshot,
  latestSnapshot,
  type RepositoryUpsert,
  type SaveSnapshotResult,
  SNAPSHOTS_KEPT,
  saveSnapshot,
  upsertRepository,
} from './snapshots.ts';
export {
  databaseLedger,
  type KnownTopicRow,
  loadRepositoryTopics,
  loadSnapshotForTopics,
  pruneRepositoryTopics,
  saveTopics,
  snapshotTopicGraph,
  type TopicToSave,
  withAdvisoryLock,
} from './topics.ts';
