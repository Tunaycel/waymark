import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { createGzip } from 'node:zlib';
import { pack } from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { IndexCrashedError, IndexTimeoutError, indexInThread } from './isolated.ts';

async function tarballStream(files: Record<string, string>): Promise<ReadableStream<Uint8Array>> {
  const archive = pack();
  for (const [path, content] of Object.entries(files))
    archive.entry({ name: `r/${path}` }, content);
  archive.finalize();
  const tgz = await buffer(archive.pipe(createGzip()));
  return Readable.toWeb(Readable.from([tgz])) as ReadableStream<Uint8Array>;
}

describe('indexInThread', () => {
  it('indexes a transferred download stream in a separate thread', async () => {
    const stream = await tarballStream({
      'src/a.ts': "import { b } from './b';",
      'src/b.ts': 'export const b = 1;',
    });
    const index = await indexInThread(stream);
    expect(index.edges).toEqual([{ from: 'src/a.ts', to: 'src/b.ts' }]);
  });

  it('kills a run that exceeds its time budget while the main thread stays responsive', async () => {
    const stream = await tarballStream({ 'a.ts': '' });
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 10);
    const started = performance.now();
    await expect(
      indexInThread(stream, {
        timeoutMs: 500,
        entry: new URL('./testing/hang-thread.ts', import.meta.url),
      }),
    ).rejects.toBeInstanceOf(IndexTimeoutError);
    clearInterval(ticker);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(ticks).toBeGreaterThan(10); // the event loop kept running during the busy loop
  });

  it('contains a run that exhausts its memory budget', async () => {
    const stream = await tarballStream({ 'a.ts': '' });
    await expect(
      indexInThread(stream, {
        maxHeapMb: 64,
        entry: new URL('./testing/oom-thread.ts', import.meta.url),
      }),
    ).rejects.toMatchObject({ name: 'IndexCrashedError', outOfMemory: true });
  });

  it('reports a corrupt archive as a failure, not a hang', async () => {
    const stream = Readable.toWeb(
      Readable.from([Buffer.from('not gzip')]),
    ) as ReadableStream<Uint8Array>;
    await expect(indexInThread(stream, { timeoutMs: 10_000 })).rejects.toBeInstanceOf(
      IndexCrashedError,
    );
  });
});
