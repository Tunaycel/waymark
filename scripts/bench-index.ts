/**
 * Benchmarks the indexer on public GitHub repositories, along the same path the worker takes:
 * gzipped tarball → stream-extract → index → store in Postgres.
 *
 *   pnpm bench:index fastify/fastify django/django …
 *
 * Each tarball is downloaded once (anonymously, from codeload.github.com) and kept in memory, so
 * indexing time is measured without network noise. With DATABASE_URL set, the snapshot is also
 * written to a throwaway repository row and removed afterwards.
 */
import { Readable } from 'node:stream';
import { createDatabase, repositories, saveSnapshot } from '@waymark/db';
import { indexRepository, tarballSource } from '@waymark/indexer';
import { eq } from 'drizzle-orm';

const repos = process.argv.slice(2).filter((a) => a !== '--');
if (repos.length === 0) throw new Error('Usage: pnpm bench:index owner/repo [owner/repo …]');

const database = process.env.DATABASE_URL ? createDatabase(process.env.DATABASE_URL) : null;
const rows: Record<string, Record<string, string | number>> = {};
const samples: Record<string, unknown> = {};

for (const [i, fullName] of repos.entries()) {
  const t0 = performance.now();
  const res = await fetch(`https://codeload.github.com/${fullName}/tar.gz/HEAD`);
  if (!res.ok) throw new Error(`${fullName}: download failed with ${res.status}`);
  const tarball = new Uint8Array(await res.arrayBuffer());
  const downloadMs = performance.now() - t0;

  globalThis.gc?.();
  const rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);

  const t1 = performance.now();
  const index = await indexRepository(tarballSource(Readable.from([tarball])));
  const indexMs = performance.now() - t1;
  clearInterval(sampler);

  let saveMs = Number.NaN;
  if (database) {
    const githubId = 990_000_000 + i;
    await database.db.delete(repositories).where(eq(repositories.githubId, githubId));
    const [repo] = await database.db
      .insert(repositories)
      .values({ githubId, fullName: `bench/${fullName}`, defaultBranch: 'main', isPrivate: false })
      .returning({ id: repositories.id });
    const t2 = performance.now();
    await saveSnapshot(database.db, repo?.id as string, 'f'.repeat(40), index);
    saveMs = performance.now() - t2;
    await database.db.delete(repositories).where(eq(repositories.githubId, githubId));
  }

  const { imports } = index.stats;
  const internalLooking = imports.internal + imports.unresolved;
  rows[fullName] = {
    'tarball MB': +(tarball.byteLength / 1e6).toFixed(1),
    files: index.stats.files,
    'lines (code)': index.stats.lines,
    modules: index.modules.length,
    'file edges': index.edges.length,
    'internal resolved %': internalLooking
      ? +((imports.internal / internalLooking) * 100).toFixed(1)
      : 'n/a',
    'external deps': index.externalDependencies.length,
    markers: index.markers.length,
    'index ms': Math.round(indexMs),
    'files/s': Math.round(index.stats.files / (indexMs / 1000)),
    'peak +RSS MB': Math.round((peakRss - rssBefore) / 1e6),
    'save ms': Number.isNaN(saveMs) ? 'n/a' : Math.round(saveMs),
    'download ms': Math.round(downloadMs),
  };
  samples[fullName] = {
    languages: Object.entries(index.stats.languages)
      .sort((a, b) => b[1].lines - a[1].lines)
      .slice(0, 3)
      .map(([l]) => l),
    frameworks: index.frameworks,
    truncated: index.stats.truncated,
    unresolved: index.unresolvedSamples.slice(0, 5),
  };
  console.error(`indexed ${fullName}`);
}

console.table(rows);
console.log(JSON.stringify(samples, null, 2));
await database?.close();
