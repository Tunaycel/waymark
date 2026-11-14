/** Entry point of the indexing process started by `indexIsolated`: tarball on stdin, index over IPC. */
import { indexRepository } from './indexer.ts';
import { serveIsolated } from './isolated.ts';
import { tarballSource } from './sources/tarball.ts';
import type { IndexLimits } from './types.ts';

// argv: [node, script, timeoutMs, limitsJson]
const limits = JSON.parse(process.argv[3] ?? '{}') as IndexLimits;

serveIsolated(
  () =>
    indexRepository(tarballSource(process.stdin, { maxFileBytes: limits.maxFileBytes }), limits),
  false,
);
