import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { createGzip } from 'node:zlib';
import { pack } from 'tar-stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexRepository } from '../indexer.ts';
import type { SourceFile } from '../types.ts';
import { localSource } from './local.ts';
import { tarballSource } from './tarball.ts';

type Entry = {
  name: string;
  content?: string;
  type?: 'file' | 'symlink' | 'directory';
  linkname?: string;
};

/** Builds a gzipped tarball shaped like GitHub's (`owner-repo-sha/` prefix). */
async function tarball(entries: Entry[]): Promise<Buffer> {
  const archive = pack();
  for (const e of entries) {
    if (e.type === 'symlink')
      archive.entry({ name: e.name, type: 'symlink', linkname: e.linkname ?? '' });
    else if (e.type === 'directory') archive.entry({ name: e.name, type: 'directory' });
    else archive.entry({ name: e.name }, e.content ?? '');
  }
  archive.finalize();
  return buffer(archive.pipe(createGzip()));
}

async function collect(source: AsyncIterable<SourceFile>) {
  const out: { path: string; size: number; text: string | null }[] = [];
  for await (const f of source) {
    out.push({
      path: f.path,
      size: f.size,
      text: f.content ? new TextDecoder().decode(f.content) : null,
    });
  }
  return out;
}

describe('tarballSource', () => {
  it('streams regular files, strips the top-level folder, and skips links and directories', async () => {
    const tgz = await tarball([
      { name: 'octo-demo-abc123/', type: 'directory' },
      { name: 'octo-demo-abc123/src/a.ts', content: 'export const a = 1;' },
      { name: 'octo-demo-abc123/link.ts', type: 'symlink', linkname: '/etc/passwd' },
      { name: 'octo-demo-abc123/README.md', content: '# hi' },
    ]);
    expect(await collect(tarballSource(Readable.from([tgz])))).toEqual([
      { path: 'src/a.ts', size: 19, text: 'export const a = 1;' },
      { path: 'README.md', size: 4, text: '# hi' },
    ]);
  });

  it('lists large files without buffering them', async () => {
    const tgz = await tarball([
      { name: 'p/big.bin', content: 'x'.repeat(5_000) },
      { name: 'p/after.ts', content: 'ok' },
    ]);
    expect(await collect(tarballSource(Readable.from([tgz]), { maxFileBytes: 1_000 }))).toEqual([
      { path: 'big.bin', size: 5_000, text: null },
      { path: 'after.ts', size: 2, text: 'ok' },
    ]);
  });

  it('accepts web streams and async iterables (fetch bodies)', async () => {
    const tgz = await tarball([{ name: 'p/x.ts', content: 'x' }]);
    const web = new Blob([tgz]).stream();
    expect(await collect(tarballSource(web as unknown as AsyncIterable<Uint8Array>))).toHaveLength(
      1,
    );
  });

  it('stops at the archive size cap and reports truncation instead of failing (gzip bombs, huge binaries)', async () => {
    const tgz = await tarball([
      { name: 'p/a.ts', content: 'a'.repeat(100) },
      { name: 'p/huge.bin', content: 'b'.repeat(400_000) },
      { name: 'p/after.ts', content: 'c' },
    ]);
    const input = Readable.from([tgz]);
    const source = tarballSource(input, { maxArchiveBytes: 100_000 });
    expect((await collect(source)).map((f) => f.path)).toEqual(['a.ts']);
    expect(source.truncated).toBe(true);
    expect(input.destroyed).toBe(true);

    const index = await indexRepository(
      tarballSource(Readable.from([tgz]), { maxArchiveBytes: 100_000 }),
    );
    expect(index.stats.truncated).toBe(true);
    expect(index.files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('meters decompressed bytes, so zero padding after the archive end cannot run unbounded', async () => {
    const tar = await buffer(
      (() => {
        const archive = pack();
        archive.entry({ name: 'p/a.ts' }, 'x');
        archive.finalize();
        return archive;
      })(),
    );
    const padded = Buffer.concat([tar, Buffer.alloc(50_000_000)]); // 50 MB of zeros
    const tgz = await buffer(Readable.from([padded]).pipe(createGzip()));
    const started = performance.now();
    const source = tarballSource(Readable.from([tgz]), { maxArchiveBytes: 1_000_000 });
    await collect(source);
    expect(source.truncated).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('skips entries outside the wrapper directory instead of re-rooting them', async () => {
    const tgz = await tarball([
      { name: 'octo-demo-abc/src/a.ts', content: 'a' },
      { name: '../escape/x.ts', content: 'x' },
      { name: '/etc/passwd', content: 'root' },
      { name: 'other-dir/y.ts', content: 'y' },
    ]);
    expect((await collect(tarballSource(Readable.from([tgz])))).map((f) => f.path)).toEqual([
      'src/a.ts',
    ]);
  });

  it('fails on corrupt input instead of hanging', async () => {
    await expect(
      collect(tarballSource(Readable.from([Buffer.from('not gzip at all')]))),
    ).rejects.toThrow();
  });

  it('stops reading when the consumer stops early', async () => {
    const tgz = await tarball(
      Array.from({ length: 50 }, (_, i) => ({ name: `p/f${i}.ts`, content: 'x' })),
    );
    const input = Readable.from([tgz]);
    for await (const _ of tarballSource(input)) break;
    expect(input.destroyed).toBe(true);
  });

  it('feeds the indexer end to end', async () => {
    const tgz = await tarball([
      { name: 'r/src/a.ts', content: "import { b } from './b';" },
      { name: 'r/src/b.ts', content: 'export const b = 1;' },
    ]);
    const index = await indexRepository(tarballSource(Readable.from([tgz])));
    expect(index.edges).toEqual([{ from: 'src/a.ts', to: 'src/b.ts' }]);
  });
});

describe('localSource', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'waymark-local-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(dir, 'node_modules/dep'), { recursive: true });
    await writeFile(join(dir, 'src/a.ts'), "import './b';");
    await writeFile(join(dir, 'src/b.ts'), '');
    await writeFile(join(dir, 'node_modules/dep/index.js'), '');
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(2_000));
    // Symlinks need elevated rights on some Windows setups; skip creating one if refused.
    await symlink(join(dir, 'src'), join(dir, 'linked'), 'dir').catch(() => {});
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('walks a plain directory, skipping ignored folders and symlinks', async () => {
    const files = await collect(localSource(dir, { maxFileBytes: 1_000 }));
    expect(files).toEqual([
      { path: 'big.txt', size: 2_000, text: null },
      { path: 'src/a.ts', size: 13, text: "import './b';" },
      { path: 'src/b.ts', size: 0, text: '' },
    ]);
  });

  it('indexes this repository itself (git ls-files) with every internal import resolved', async () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const index = await indexRepository(localSource(root));
    const has = (from: string, to: string) =>
      index.edges.some((e) => e.from === from && e.to === to);

    expect(has('apps/worker/src/processor.ts', 'packages/db/src/index.ts')).toBe(true);
    expect(has('apps/server/src/main.ts', 'apps/server/src/app.ts')).toBe(true);
    expect(has('packages/indexer/src/indexer.ts', 'packages/indexer/src/lexers/js.ts')).toBe(true);
    expect(index.files.some((f) => f.path.startsWith('node_modules/'))).toBe(false);
    expect(index.files.some((f) => f.path === '.env')).toBe(false);
    expect(index.stats.imports.unresolved).toBe(0);
    expect(index.moduleEdges).toContainEqual(
      expect.objectContaining({ from: 'apps/worker', to: 'packages/db' }),
    );
  });
});
