import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisibleGraph } from './graph';
import type { LayoutRequest, LayoutResponse } from './layout.worker';
import { createLayouter, Superseded } from './layout-client';

/** A worker the test answers by hand. */
class FakeWorker {
  onmessage: ((e: MessageEvent<LayoutResponse>) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  sent: LayoutRequest[] = [];
  terminated = false;
  postMessage(msg: LayoutRequest) {
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  answer(id: number) {
    const data: LayoutResponse = { id, ok: true, positions: [['t:a', pos()]] };
    this.onmessage?.({ data } as MessageEvent<LayoutResponse>);
  }
  fail(message = 'boom') {
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}

const pos = () => ({ id: 't:a', x: 1, y: 2, width: 3, height: 4, parent: null });
const graph: VisibleGraph = {
  nodes: [{ kind: 'topic', id: 't:a', parent: null, topic: {} as never, caption: null }],
  edges: [],
};

let workers: FakeWorker[];
const spawn = () => {
  const w = new FakeWorker();
  workers.push(w);
  return w as unknown as Worker;
};

beforeEach(() => {
  workers = [];
  // `createLayouter` only uses workers where the global exists.
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createLayouter', () => {
  it('resolves with the positions the worker sends back', async () => {
    const layouter = createLayouter(spawn);
    const result = layouter.layout(graph);
    const w = workers[0] as FakeWorker;
    w.answer(w.sent[0]?.id as number);
    expect((await result).get('t:a')).toMatchObject({ x: 1, y: 2 });
  });

  it('supersedes a busy request: the old promise rejects and its worker is replaced', async () => {
    const layouter = createLayouter(spawn);
    const first = layouter.layout(graph);
    const second = layouter.layout(graph);
    await expect(first).rejects.toBeInstanceOf(Superseded);
    expect(workers[0]?.terminated).toBe(true);
    const w = workers[1] as FakeWorker;
    w.answer(w.sent[0]?.id as number);
    await expect(second).resolves.toBeInstanceOf(Map);
  });

  it('ignores late events from a replaced worker', async () => {
    const layouter = createLayouter(spawn);
    const first = layouter.layout(graph).catch(() => 'superseded');
    const second = layouter.layout(graph);
    const old = workers[0] as FakeWorker;
    old.fail('old died');
    old.answer(1);
    const fresh = workers[1] as FakeWorker;
    expect(fresh.terminated).toBe(false);
    fresh.answer(fresh.sent[0]?.id as number);
    await expect(second).resolves.toBeInstanceOf(Map);
    await expect(first).resolves.toBe('superseded');
  });

  it('rejects pending work on dispose', async () => {
    const layouter = createLayouter(spawn);
    const pending = layouter.layout(graph);
    layouter.dispose();
    await expect(pending).rejects.toBeInstanceOf(Superseded);
    expect(workers[0]?.terminated).toBe(true);
  });

  it('reports a failure of a worker that had worked before', async () => {
    const layouter = createLayouter(spawn);
    const ok = layouter.layout(graph);
    const w = workers[0] as FakeWorker;
    w.answer(w.sent[0]?.id as number);
    await ok;
    const failing = layouter.layout(graph);
    w.fail('crashed');
    await expect(failing).rejects.toThrow('crashed');
  });

  it('falls back to the main thread when workers never load', async () => {
    const layouter = createLayouter(spawn);
    const result = layouter.layout(graph);
    (workers[0] as FakeWorker).fail('404');
    expect((await result).has('t:a')).toBe(true);
    // And stays there: no new worker for later requests.
    await layouter.layout(graph);
    expect(workers).toHaveLength(1);
  });

  it('falls back when the Worker constructor throws', async () => {
    const layouter = createLayouter(() => {
      throw new Error('SecurityError');
    });
    await expect(layouter.layout(graph)).resolves.toBeInstanceOf(Map);
  });

  it('rejects when a message cannot be read, instead of waiting forever', async () => {
    const layouter = createLayouter(spawn);
    const result = layouter.layout(graph);
    (workers[0] as FakeWorker).onmessageerror?.();
    await expect(result).rejects.toThrow('unreadable');
  });
});
