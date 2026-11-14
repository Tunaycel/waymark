/**
 * Print the topics of a repository.
 *
 *   pnpm topics:local <path>          a local checkout
 *   pnpm topics:local owner/repo      a public GitHub repository (anonymous tarball download)
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { indexRepository, localSource, tarballSource } from '@waymark/indexer';
import { ClaudeDescriber } from './describe/claude.ts';
import { OllamaDescriber } from './describe/ollama.ts';
import { describeTopics, InMemoryLedger, repositoryBrief, topicBriefs } from './describe/run.ts';
import type { Describer } from './describe/types.ts';
import { buildTopics } from './topics.ts';

const args = process.argv.slice(2).filter((a) => a !== '--');
const cwd = process.env.INIT_CWD ?? process.cwd();
const target = args.find((a) => !a.startsWith('--')) ?? '.';
const local = resolve(cwd, target);

let source: AsyncIterable<import('@waymark/indexer').SourceFile>;
if (existsSync(local)) {
  source = localSource(local);
} else if (/^[\w.-]+\/[\w.-]+$/.test(target)) {
  const res = await fetch(`https://codeload.github.com/${target}/tar.gz/HEAD`);
  if (!res.ok || !res.body) throw new Error(`${target}: download failed with ${res.status}`);
  source = tarballSource(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream));
} else {
  throw new Error(`${target}: not a directory or owner/repo`);
}

const index = await indexRepository(source);
const started = performance.now();
const map = buildTopics(index);
const ms = Math.round(performance.now() - started);

console.log(`\n${target}`);
console.log(
  `${index.stats.files} files → ${map.topics.length} topics, ${map.edges.length} topic edges (${ms} ms)\n`,
);
const labels = new Map(map.topics.map((t) => [t.key, t.label]));

// --describe: name topics with Claude (ANTHROPIC_API_KEY) or a local model (--ollama=<model>).
const ollama = args.find((a) => a.startsWith('--ollama='))?.slice('--ollama='.length);
if (args.includes('--describe') || ollama) {
  const describer: Describer = ollama
    ? new OllamaDescriber({ model: ollama })
    : new ClaudeDescriber({ model: process.env.WAYMARK_LLM_MODEL ?? 'claude-haiku-5-5' });
  const ledger = new InMemoryLedger();
  const ids = new Map(map.topics.map((t) => [t.key, t.key]));
  const describeStarted = performance.now();
  const run = await describeTopics(
    repositoryBrief(target, index),
    topicBriefs(map, ids, index.manifests),
    {
      describer,
      ledger,
      monthlyBudgetUsd: 0.5, // per CLI run
      onBatchError: (err) => console.error(`batch failed: ${(err as Error).message}`),
    },
  );
  for (const t of map.topics) {
    const d = run.descriptions.get(t.key);
    if (d) labels.set(t.key, d.name);
  }
  const usage = ledger.entries.reduce(
    (a, e) => ({ input: a.input + e.inputTokens, output: a.output + e.outputTokens }),
    { input: 0, output: 0 },
  );
  console.log(
    `${describer.provider}/${describer.model}: ${run.descriptions.size}/${map.topics.length} described in ${ledger.entries.length} requests, ${Math.round(performance.now() - describeStarted)} ms, ${usage.input} in / ${usage.output} out tokens, $${run.spentUsd.toFixed(4)}${run.stoppedBy ? ` (stopped: ${run.stoppedBy})` : ''}
`,
  );
  for (const t of map.topics) {
    const d = run.descriptions.get(t.key);
    console.log(`- ${d?.name ?? t.label}  [${d?.role ?? '?'}]  ${t.package || '(root)'} · ${t.sourceFiles} files
    ${d?.summary ?? '(heuristic label)'}`);
  }
  console.log('');
}
console.table(
  map.topics.map((t) => ({
    package: t.package || '(root)',
    label: t.label,
    directory: t.directory,
    files: `${t.sourceFiles}+${t.testFiles}t`,
    lines: t.lines,
    externals: t.externals.slice(0, 3).join(', '),
    uses: map.edges
      .filter((e) => e.from === t.key)
      .slice(0, 2)
      .map((e) => labels.get(e.to))
      .join(', '),
  })),
);
