import type { VisibleGraph } from './graph';
import { type ElkLike, layoutGraph, type Positioned } from './layout';
import type { LayoutRequest, LayoutResponse } from './layout.worker';

/**
 * Runs `layoutGraph` in a Web Worker. A newer request supersedes an older one: the busy worker is
 * terminated (ELK can't be interrupted otherwise) and the older promise rejects with `Superseded`.
 * Where workers are unavailable, ELK runs on the main thread as before.
 */
export class Superseded extends Error {
  constructor() {
    super('layout superseded by a newer request');
    this.name = 'Superseded';
  }
}

type Pending = {
  id: number;
  resolve: (p: Map<string, Positioned>) => void;
  reject: (e: unknown) => void;
};

export interface Layouter {
  layout(graph: VisibleGraph): Promise<Map<string, Positioned>>;
  dispose(): void;
}

const spawnLayoutWorker = () =>
  new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });

/**
 * @param spawnWorker injectable for tests. Each superseded request costs a fresh worker (and a
 * re-parse of ELK, ~1.5 MB): ELK has no way to stop a running layout, and a stale one would
 * otherwise delay the layout the viewer is waiting for.
 */
export function createLayouter(spawnWorker: () => Worker = spawnLayoutWorker): Layouter {
  if (typeof Worker === 'undefined') return mainThreadLayouter();
  let worker: Worker | null = null;
  let pending: (Pending & { graph: VisibleGraph }) | null = null;
  let nextId = 0;
  /** Set once a worker has answered: before that, a failure may mean workers can't load at all. */
  let workerWorks = false;
  /** Workers can't load here (blocked by policy, old browser): lay out on the main thread. */
  let fallback: Layouter | null = null;

  const stop = () => {
    worker?.terminate();
    worker = null;
  };

  const spawn = () => {
    const w = spawnWorker();
    w.onmessage = (event: MessageEvent<LayoutResponse>) => {
      if (worker !== w) return;
      workerWorks = true;
      const data = event.data;
      if (!pending || data.id !== pending.id) return;
      const done = pending;
      pending = null;
      if (data.ok) done.resolve(new Map(data.positions));
      else done.reject(new Error(data.error));
    };
    w.onmessageerror = () => {
      if (worker !== w) return;
      const done = pending;
      pending = null;
      stop();
      done?.reject(new Error('layout worker sent an unreadable message'));
    };
    w.onerror = (event) => {
      if (worker !== w) return;
      event.preventDefault?.();
      const done = pending;
      pending = null;
      stop();
      if (!workerWorks) {
        // Never worked: switch for good, and finish this request on the main thread.
        fallback = mainThreadLayouter();
        if (done) fallback.layout(done.graph).then(done.resolve, done.reject);
        return;
      }
      done?.reject(new Error(event.message || 'layout worker failed'));
    };
    return w;
  };

  return {
    layout(graph) {
      if (fallback) return fallback.layout(graph);
      if (pending) {
        // The busy worker is working on something nobody wants any more.
        pending.reject(new Superseded());
        pending = null;
        stop();
      }
      let w = worker;
      if (!w) {
        try {
          w = spawn();
        } catch {
          // The constructor itself can throw (a content policy forbidding workers): never let
          // that escape as a synchronous error, and stop trying.
          fallback = mainThreadLayouter();
          return fallback.layout(graph);
        }
      }
      worker = w;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending = { id, graph, resolve, reject };
        w.postMessage({ id, graph } satisfies LayoutRequest);
      });
    },
    dispose() {
      pending?.reject(new Superseded());
      pending = null;
      stop();
    },
  };
}

function mainThreadLayouter(): Layouter {
  let elk: Promise<ElkLike> | null = null;
  return {
    async layout(graph) {
      elk ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default());
      return layoutGraph(await elk, graph);
    },
    dispose() {},
  };
}
