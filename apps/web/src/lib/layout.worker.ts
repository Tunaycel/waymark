/// <reference lib="webworker" />
import ELK from 'elkjs/lib/elk.bundled.js';
import type { VisibleGraph } from './graph';
import { layoutGraph, type Positioned } from './layout';

/**
 * Lays out graphs off the main thread: ELK needs seconds for a few hundred nodes, and on the page's
 * thread that froze scrolling, hover, and input. One request at a time; the client replaces this
 * worker when a newer request makes the current one stale.
 */
const elk = new ELK();

export interface LayoutRequest {
  id: number;
  graph: VisibleGraph;
}

export type LayoutResponse =
  | { id: number; ok: true; positions: [string, Positioned][] }
  | { id: number; ok: false; error: string };

self.onmessage = async (event: MessageEvent<LayoutRequest>) => {
  const { id, graph } = event.data;
  try {
    const positions = await layoutGraph(elk, graph);
    self.postMessage({ id, ok: true, positions: [...positions] } satisfies LayoutResponse);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error) } satisfies LayoutResponse);
  }
};
