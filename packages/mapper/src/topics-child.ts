/** Entry point of the process started by `buildTopicsIsolated`: input over IPC, topics back. */
import { serveIsolated } from '@waymark/indexer';
import { buildTopics, type TopicInput } from './topics.ts';

serveIsolated(async (message) => buildTopics(message as TopicInput), true);
