/** Entry point of the indexing thread started by `indexInThread`. */
import { parentPort, workerData } from 'node:worker_threads';
import { indexRepository } from './indexer.ts';
import { tarballSource } from './sources/tarball.ts';
import type { IndexLimits } from './types.ts';

const { limits } = workerData as { limits: IndexLimits };

parentPort?.once('message', async ({ tarball }: { tarball: ReadableStream<Uint8Array> }) => {
  try {
    const source = tarballSource(tarball as unknown as AsyncIterable<Uint8Array>, {
      maxFileBytes: limits.maxFileBytes,
    });
    const index = await indexRepository(source, limits);
    parentPort?.postMessage({ ok: true, index });
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
