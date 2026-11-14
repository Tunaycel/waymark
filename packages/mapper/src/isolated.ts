import { runIsolated } from '@waymark/indexer';
import type { TopicInput, TopicMap } from './topics.ts';

export interface IsolatedTopicsOptions {
  timeoutMs?: number;
  maxHeapMb?: number;
}

/**
 * Builds topics in a separate process with hard time and memory budgets. Clustering is CPU-bound
 * on untrusted structure; out of process it can't block the worker's event loop (and its queue
 * locks), and an input that blows a budget fails that one build, never the worker.
 */
export function buildTopicsIsolated(
  input: TopicInput,
  { timeoutMs = 120_000, maxHeapMb = 1_024 }: IsolatedTopicsOptions = {},
): Promise<TopicMap> {
  return runIsolated<TopicMap>(new URL('./topics-child.ts', import.meta.url), {
    timeoutMs,
    maxHeapMb,
    message: input,
  });
}
