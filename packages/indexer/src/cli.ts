/**
 * Index a local checkout and print what the map is built from.
 *
 *   pnpm map:local <path> [--json]
 */
import { resolve } from 'node:path';
import { indexRepository } from './indexer.ts';
import { localSource } from './sources/local.ts';

const args = process.argv.slice(2).filter((a) => a !== '--');
const json = args.includes('--json');
// `pnpm map:local` runs inside packages/indexer; resolve paths from where the user typed it.
const cwd = process.env.INIT_CWD ?? process.cwd();
const target = resolve(cwd, args.find((a) => !a.startsWith('--')) ?? '.');

const index = await indexRepository(localSource(target));

if (json) {
  process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
} else {
  const { stats } = index;
  const internalLooking = stats.imports.internal + stats.imports.unresolved;
  const resolution =
    internalLooking === 0
      ? 'n/a'
      : `${((stats.imports.internal / internalLooking) * 100).toFixed(1)}%`;

  console.log(`\n${target}\n`);
  console.table({
    files: stats.files,
    'files analysed': stats.analysedFiles,
    'lines (code & text)': stats.lines,
    modules: index.modules.length,
    'file edges': index.edges.length,
    'module edges': index.moduleEdges.length,
    'external dependencies': index.externalDependencies.length,
    'internal import resolution': resolution,
    'TODO/FIXME markers': index.markers.length,
    truncated: stats.truncated,
    'duration (ms)': stats.durationMs,
  });
  if (index.frameworks.length) console.log(`Frameworks: ${index.frameworks.join(', ')}\n`);

  const languages = Object.entries(stats.languages)
    .sort((a, b) => b[1].lines - a[1].lines)
    .slice(0, 8);
  console.log('Languages');
  console.table(Object.fromEntries(languages));

  console.log('Largest modules');
  console.table(
    [...index.modules]
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 12)
      .map((m) => ({ module: m.id, files: m.files, lines: m.lines })),
  );

  console.log('Strongest module dependencies');
  console.table(index.moduleEdges.slice(0, 12));

  if (index.unresolvedSamples.length) {
    console.log('Unresolved internal imports (sample)');
    console.table(index.unresolvedSamples.slice(0, 10));
  }
}
