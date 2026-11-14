import { fork } from 'node:child_process';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { DEFAULT_LIMITS, type IndexLimits, type RepoIndex } from './types.ts';

/** Work did not finish within its time budget; the process was killed. */
export class IndexTimeoutError extends Error {
  constructor(ms: number) {
    super(`Isolated work did not finish within ${ms} ms`);
    this.name = 'IndexTimeoutError';
  }
}

/** The work failed inside the child process, or the process died. */
export class IndexCrashedError extends Error {
  /** The process exceeded its heap budget: the same input will do so again. */
  readonly outOfMemory: boolean;

  constructor(message: string, outOfMemory = false) {
    super(message);
    this.name = 'IndexCrashedError';
    this.outOfMemory = outOfMemory;
  }
}

export interface IsolationOptions {
  /** Hard budget; the process is killed when it runs out. */
  timeoutMs: number;
  /** Heap budget of the child. Exceeding it kills that process, never this one. */
  maxHeapMb: number;
  /** Extra arguments for the child (after the time budget). */
  args?: string[];
  /** Piped to the child's stdin. */
  stdin?: Readable;
  /** Sent to the child over IPC once it starts. */
  message?: unknown;
}

const STDERR_TAIL = 4_096;

/**
 * The environment a child gets: enough for Node to run, nothing secret. It processes untrusted
 * repository content, so it must not hold API keys, database URLs, or the GitHub App key.
 */
export function minimalChildEnv(): Record<string, string> {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'TZ'];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

type ChildReply<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Runs `entry` in a forked Node process and returns the value it sends back.
 *
 * Repository content is untrusted and the work is CPU- and memory-bound. In-process, one
 * pathological input would block the event loop (no timeout can interrupt synchronous work, and
 * queue locks could not be renewed). A worker thread is not enough: when a thread hits its heap
 * limit, V8 can abort the whole process. A child process is the boundary that holds: a run over
 * its time or memory budget is killed without touching the caller. The child also enforces the
 * time budget itself, so it can't outlive a parent that died.
 */
export function runIsolated<T>(entry: URL, options: IsolationOptions): Promise<T> {
  const child = fork(entry, [String(options.timeoutMs), ...(options.args ?? [])], {
    execArgv: [`--max-old-space-size=${options.maxHeapMb}`],
    serialization: 'advanced',
    stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    env: minimalChildEnv() as NodeJS.ProcessEnv,
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
  });

  // The child may exit before reading everything (limit reached, crash): not an error here.
  child.stdin?.on('error', () => {});
  const input = options.stdin;
  if (input) {
    input.on('error', () => child.kill('SIGKILL'));
    input.pipe(child.stdin as NodeJS.WritableStream);
  } else {
    child.stdin?.end();
  }
  if (options.message !== undefined) child.send(options.message as never);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (input) {
        input.unpipe();
        input.destroy();
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new IndexTimeoutError(options.timeoutMs))),
      options.timeoutMs,
    );

    child.once('message', (reply: ChildReply<T>) => {
      finish(() => (reply.ok ? resolve(reply.value) : reject(new IndexCrashedError(reply.error))));
    });
    child.once('error', (err) => finish(() => reject(new IndexCrashedError(err.message))));
    child.once('exit', (code, signal) =>
      finish(() => {
        const outOfMemory = /heap out of memory|Reached heap limit/i.test(stderr);
        reject(
          new IndexCrashedError(
            outOfMemory
              ? 'isolated process ran out of memory'
              : `isolated process exited (code ${code}, signal ${signal})`,
            outOfMemory,
          ),
        );
      }),
    );
  });
}

/**
 * Child side: enforces the time budget passed as the first argument (so an orphaned child can't
 * run forever) and sends the result or the error back.
 */
export function serveIsolated<T>(
  work: (message: unknown) => Promise<T>,
  waitForMessage: boolean,
): void {
  const budget = Number(process.argv[2]);
  if (Number.isFinite(budget) && budget > 0) {
    setTimeout(() => process.exit(124), budget + 5_000).unref();
  }
  const run = async (message: unknown) => {
    try {
      const value = await work(message);
      process.send?.({ ok: true, value }, () => process.exit(0));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      process.send?.({ ok: false, error }, () => process.exit(1));
    }
  };
  if (waitForMessage) process.once('message', (m) => void run(m));
  else void run(undefined);
}

export interface IsolatedIndexOptions {
  limits?: IndexLimits;
  /** Hard budget for download + indexing; the process is killed when it runs out. */
  timeoutMs?: number;
  /** Heap budget of the indexing process. */
  maxHeapMb?: number;
  /** Entry point; tests substitute a misbehaving one. */
  entry?: URL;
}

/** Indexes a gzipped tarball stream in a separate process (download piped to its stdin). */
export function indexIsolated(
  tarball: ReadableStream<Uint8Array>,
  {
    limits = DEFAULT_LIMITS,
    timeoutMs = 10 * 60_000,
    maxHeapMb = 1_536,
    entry = new URL('./isolated-child.ts', import.meta.url),
  }: IsolatedIndexOptions = {},
): Promise<RepoIndex> {
  return runIsolated<RepoIndex>(entry, {
    timeoutMs,
    maxHeapMb,
    args: [JSON.stringify(limits)],
    stdin: Readable.fromWeb(tarball as unknown as WebReadableStream<Uint8Array>),
  });
}
