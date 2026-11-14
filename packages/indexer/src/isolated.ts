import { type Transferable, Worker } from 'node:worker_threads';
import { DEFAULT_LIMITS, type IndexLimits, type RepoIndex } from './types.ts';

/** Indexing did not finish within its time budget; the thread was killed. */
export class IndexTimeoutError extends Error {
  constructor(ms: number) {
    super(`Indexing did not finish within ${ms} ms`);
    this.name = 'IndexTimeoutError';
  }
}

/** Indexing failed inside the thread, or the thread died. */
export class IndexCrashedError extends Error {
  /** The thread exceeded its heap budget: the same repository will do so again. */
  readonly outOfMemory: boolean;

  constructor(message: string, outOfMemory = false) {
    super(message);
    this.name = 'IndexCrashedError';
    this.outOfMemory = outOfMemory;
  }
}

export interface IsolatedIndexOptions {
  limits?: IndexLimits;
  /** Hard budget for download + indexing; the thread is terminated when it runs out. */
  timeoutMs?: number;
  /** Heap budget of the indexing thread. Exceeding it kills the thread, not the process. */
  maxHeapMb?: number;
  /** Thread entry point; tests substitute a misbehaving one. */
  entry?: URL;
}

const DEFAULT_ENTRY = new URL('./isolated-thread.ts', import.meta.url);

/**
 * Indexes a gzipped tarball stream in a separate thread.
 *
 * Repository content is untrusted and indexing is CPU-bound. In-process, one pathological file
 * would block the event loop: no timeout can interrupt synchronous work, the queue lock could not
 * be renewed, and the job would be re-run elsewhere again and again. Here the main thread stays
 * responsive and a run that exceeds its time or memory budget is killed.
 */
export function indexInThread(
  tarball: ReadableStream<Uint8Array>,
  {
    limits = DEFAULT_LIMITS,
    timeoutMs = 10 * 60_000,
    maxHeapMb = 1_536,
    entry = DEFAULT_ENTRY,
  }: IsolatedIndexOptions = {},
): Promise<RepoIndex> {
  const worker = new Worker(entry, {
    workerData: { limits },
    resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
  });

  return new Promise<RepoIndex>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(
      () => finish(() => reject(new IndexTimeoutError(timeoutMs))),
      timeoutMs,
    );

    worker.once(
      'message',
      (message: { ok: true; index: RepoIndex } | { ok: false; error: string }) => {
        finish(() =>
          message.ok ? resolve(message.index) : reject(new IndexCrashedError(message.error)),
        );
      },
    );
    worker.once('error', (err: Error & { code?: string }) =>
      finish(() =>
        reject(new IndexCrashedError(err.message, err.code === 'ERR_WORKER_OUT_OF_MEMORY')),
      ),
    );
    worker.once('exit', (code) =>
      finish(() => reject(new IndexCrashedError(`indexing thread exited with code ${code}`))),
    );

    // The stream is transferred, not copied: the thread reads the download directly.
    worker.postMessage({ tarball }, [tarball as unknown as Transferable]);
  });
}
