/**
 * Load test for the ingestion path, run against a live server + worker.
 *
 *   pnpm infra:up && pnpm db:migrate && pnpm dev     # in one terminal
 *   pnpm bench [deliveries=1000] [concurrency=50] [commitsPerPush=5]
 *
 * Sends signed `push` deliveries the way GitHub does, measures how fast the server acknowledges
 * them (what GitHub's 10 s timeout cares about), then waits until the worker has persisted every
 * commit and reports end-to-end throughput.
 */
import { signGitHubPayload } from '@waymark/core';
import { pushPayload } from '@waymark/core/testing';
import postgres from 'postgres';

const [deliveries = 1000, concurrency = 50, commitsPerPush = 5] = process.argv
  .slice(2)
  .filter((a) => a !== '--')
  .map(Number);
const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const secret = process.env.GITHUB_WEBHOOK_SECRET;
const dbUrl = process.env.DATABASE_URL;
if (!secret || !dbUrl) throw new Error('Set GITHUB_WEBHOOK_SECRET and DATABASE_URL (see .env)');

const sql = postgres(dbUrl, { max: 1 });
const runId = Date.now();
const repoId = 900_000_000 + (runId % 1_000_000);
/** Unique 40-hex SHA per (run, push, commit), built as a string to avoid float precision loss. */
const commitSha = (i: number, j: number) =>
  (runId.toString(16) + i.toString(16).padStart(8, '0') + j.toString(16).padStart(4, '0')).padStart(
    40,
    '0',
  );

function body(i: number): string {
  const template = pushPayload().commits[0];
  return JSON.stringify(
    pushPayload({
      repository: {
        id: repoId,
        full_name: `bench/run-${runId}`,
        private: true,
        default_branch: 'main',
      },
      commits: Array.from({ length: commitsPerPush }, (_, j) => {
        const id = commitSha(i, j);
        return { ...template, id, url: `https://github.com/bench/x/commit/${id}` };
      }),
    }),
  );
}

const latencies: number[] = [];
const statuses = new Map<number, number>();
let next = 0;

async function client() {
  while (next < deliveries) {
    const i = next++;
    const raw = body(i);
    const started = performance.now();
    const res = await fetch(`${base}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': `bench-${runId}-${i}`,
        'x-hub-signature-256': signGitHubPayload(secret as string, raw),
      },
      body: raw,
    });
    await res.arrayBuffer();
    latencies.push(performance.now() - started);
    statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
  }
}

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

const t0 = performance.now();
await Promise.all(Array.from({ length: concurrency }, client));
const ackSeconds = (performance.now() - t0) / 1000;

const expected = deliveries * commitsPerPush;
let stored = 0;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const [row] = await sql`
    select count(*)::int as n from commits c
    join repositories r on r.id = c.repository_id where r.github_id = ${repoId}`;
  stored = row?.n ?? 0;
  if (stored >= expected) break;
  await new Promise((r) => setTimeout(r, 100));
}
const totalSeconds = (performance.now() - t0) / 1000;

await sql`delete from repositories where github_id = ${repoId}`;
await sql.end();

const sorted = latencies.toSorted((a, b) => a - b);
console.table({
  deliveries: { value: deliveries },
  concurrency: { value: concurrency },
  'commits stored / expected': { value: `${stored} / ${expected}` },
  'HTTP status counts': { value: JSON.stringify(Object.fromEntries(statuses)) },
  'ack p50 (ms)': { value: pct(sorted, 50).toFixed(1) },
  'ack p95 (ms)': { value: pct(sorted, 95).toFixed(1) },
  'ack p99 (ms)': { value: pct(sorted, 99).toFixed(1) },
  'ack max (ms)': { value: (sorted.at(-1) ?? 0).toFixed(1) },
  'ack throughput (req/s)': { value: (deliveries / ackSeconds).toFixed(0) },
  'end-to-end (commits/s)': { value: (stored / totalSeconds).toFixed(0) },
});
if (stored !== expected) process.exitCode = 1;
