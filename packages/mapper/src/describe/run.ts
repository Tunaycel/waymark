import type { Manifest, ReadmeExcerpt } from '@waymark/indexer';
import type { TopicMap } from '../topics.ts';
import {
  DescribeError,
  type Describer,
  type DescribeUsage,
  type RepositoryBrief,
  type TopicBrief,
  type TopicDescription,
} from './types.ts';

/** Where spending is recorded, so a monthly cap holds across jobs and restarts. */
export interface SpendLedger {
  spentThisMonthUsd(): Promise<number>;
  record(entry: { provider: string; model: string } & DescribeUsage): Promise<void>;
}

export class InMemoryLedger implements SpendLedger {
  spent = 0;
  readonly entries: ({ provider: string; model: string } & DescribeUsage)[] = [];

  async spentThisMonthUsd(): Promise<number> {
    return this.spent;
  }

  async record(entry: { provider: string; model: string } & DescribeUsage): Promise<void> {
    this.entries.push(entry);
    this.spent += entry.costUsd;
  }
}

export interface DescribeRunOptions {
  describer: Describer;
  ledger: SpendLedger;
  /** Hard monthly cap in USD. A batch that could exceed it is not sent. */
  monthlyBudgetUsd: number;
  /** Topics per request: fewer requests, shared repository context. */
  batchSize?: number;
  /** Requests in flight at once. */
  concurrency?: number;
  /** Ends the whole run (e.g. an overall time budget); undescribed topics stay heuristic. */
  signal?: AbortSignal;
  onBatchError?: (err: unknown, ids: string[]) => void;
}

export interface DescribeRunResult {
  descriptions: Map<string, TopicDescription>;
  /** Ids that were not described (budget reached, provider error, or omitted by the model). */
  missing: string[];
  stoppedBy: 'budget' | 'error' | 'aborted' | null;
  /** What this run was billed (as recorded in the ledger). */
  spentUsd: number;
}

const isCost = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const positiveInt = (n: unknown, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;

/**
 * Describes topics batch by batch within a monthly budget.
 *
 * The ledger is read once; from then on every check is synchronous against
 * `spent before this run + billed in this run + worst case of requests in flight`, so concurrent
 * requests can't overshoot together. (Several processes sharing one ledger must serialise runs;
 * see `withAdvisoryLock` in the database package.) A billed call is always recorded, even when its
 * output was unusable; an unknown or invalid cost is charged at the request's worst case.
 *
 * Never throws for provider or ledger problems: what could not be described keeps its heuristic
 * label and is retried on a later build.
 */
export async function describeTopics(
  repo: RepositoryBrief,
  briefs: TopicBrief[],
  { describer, ledger, monthlyBudgetUsd, signal, onBatchError, ...options }: DescribeRunOptions,
): Promise<DescribeRunResult> {
  const batchSize = positiveInt(options.batchSize, 8);
  const concurrency = positiveInt(options.concurrency, 4);
  const descriptions = new Map<string, TopicDescription>();
  let billed = 0;
  let reserved = 0;
  let stoppedBy: DescribeRunResult['stoppedBy'] = null;
  const result = (): DescribeRunResult => ({
    descriptions,
    missing: briefs.map((b) => b.id).filter((id) => !descriptions.has(id)),
    stoppedBy,
    spentUsd: billed,
  });

  let spentBefore: number;
  try {
    spentBefore = await ledger.spentThisMonthUsd();
  } catch (err) {
    onBatchError?.(err, []);
    stoppedBy = 'error';
    return result();
  }
  if (!isCost(spentBefore) || !isCost(monthlyBudgetUsd)) {
    stoppedBy = 'budget';
    return result();
  }

  const batches: TopicBrief[][] = [];
  for (let i = 0; i < briefs.length; i += batchSize) batches.push(briefs.slice(i, i + batchSize));
  let next = 0;

  const charge = async (usage: DescribeUsage | undefined, estimate: number) => {
    const cost = usage && isCost(usage.costUsd) ? usage.costUsd : estimate;
    billed += cost;
    try {
      await ledger.record({
        provider: describer.provider,
        model: describer.model,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: cost,
      });
    } catch (err) {
      // Spending that can't be recorded must not continue: stop, keeping what was paid for.
      onBatchError?.(err, []);
      stoppedBy ??= 'error';
    }
  };

  async function lane(): Promise<void> {
    while (stoppedBy === null && next < batches.length) {
      if (signal?.aborted) {
        stoppedBy = 'aborted';
        return;
      }
      const batch = batches[next++] as TopicBrief[];
      const ids = new Set(batch.map((b) => b.id));
      const estimate = describer.estimateCostUsd(repo, batch);
      if (!isCost(estimate)) {
        stoppedBy = 'error';
        return;
      }
      if (spentBefore + billed + reserved + estimate > monthlyBudgetUsd) {
        stoppedBy ??= 'budget';
        return;
      }
      reserved += estimate;
      try {
        const answer = await describer.describe(repo, batch, signal);
        reserved -= estimate;
        // Keep what was paid for before anything else can fail.
        for (const d of answer.descriptions) if (ids.has(d.id)) descriptions.set(d.id, d);
        await charge(answer.usage, estimate);
      } catch (err) {
        reserved -= estimate;
        const known = err instanceof DescribeError;
        // A failed call may still have been billed: record what is known, else the worst case.
        if (known && err.usage) await charge(err.usage, estimate);
        else if (!known) await charge(undefined, estimate);
        onBatchError?.(err, [...ids]);
        if (signal?.aborted) stoppedBy ??= 'aborted';
        else if (!known || err.stopRun) stoppedBy ??= 'error';
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, lane));
  return result();
}

/** Repository-level context shared by every batch. Tolerates summaries from older indexes. */
export function repositoryBrief(
  name: string,
  summary: { manifests?: Manifest[]; readmes?: ReadmeExcerpt[]; frameworks?: string[] },
): RepositoryBrief {
  const manifests = summary.manifests ?? [];
  const readmes = summary.readmes ?? [];
  const root = manifests.find((m) => !m.path.includes('/'));
  const readme = readmes.find((r) => !r.path.includes('/')) ?? readmes[0];
  return {
    name: clip(name, 200),
    description: root?.description ? clip(root.description, 200) : null,
    readme: readme?.text ? clip(readme.text, 400) : null,
    frameworks: (summary.frameworks ?? []).slice(0, 20),
  };
}

const clip = (text: string, max: number) => Array.from(text).slice(0, max).join('');
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * Per-topic briefs: structure only, bounded in size (paths ≤ 200 characters, ≤ 40 files, ≤ 40
 * symbols, ≤ 5 neighbours each way), so a batch stays far below long-context pricing.
 * `ids` maps topic keys to stable ids.
 */
export function topicBriefs(
  map: TopicMap,
  ids: Map<string, string>,
  manifests: Pick<Manifest, 'path' | 'name' | 'description'>[],
): TopicBrief[] {
  const labels = new Map(map.topics.map((t) => [t.key, t.label]));
  const manifestByDir = new Map<string, Pick<Manifest, 'name' | 'description'>>();
  for (const m of manifests) {
    if (!manifestByDir.has(dirname(m.path))) manifestByDir.set(dirname(m.path), m);
  }
  const out = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  for (const e of map.edges) {
    const a = out.get(e.from) ?? [];
    if (a.length < 5) a.push(e.to);
    out.set(e.from, a);
    const b = into.get(e.to) ?? [];
    if (b.length < 5) b.push(e.from);
    into.set(e.to, b);
  }

  return map.topics.map((t) => {
    const manifest = manifestByDir.get(t.package);
    const relative = (f: string) =>
      t.package && f.startsWith(`${t.package}/`) ? f.slice(t.package.length + 1) : f;
    return {
      id: ids.get(t.key) ?? t.key,
      package: t.package,
      packageName: manifest?.name ? clip(manifest.name, 100) : null,
      packageDescription: manifest?.description ? clip(manifest.description, 200) : null,
      directory: clip(t.directory, 200),
      files: t.files.slice(0, 40).map((f) => clip(relative(f), 200)),
      sourceFiles: t.sourceFiles,
      testFiles: t.testFiles,
      lines: t.lines,
      languages: Object.entries(t.languages)
        .sort((a, b) => b[1] - a[1])
        .map(([l]) => l)
        .slice(0, 5),
      symbols: t.symbols.slice(0, 40).map((s) => clip(s, 64)),
      externals: t.externals.slice(0, 10).map((s) => clip(s, 100)),
      uses: (out.get(t.key) ?? []).map((k) => labels.get(k) ?? ''),
      usedBy: (into.get(t.key) ?? []).map((k) => labels.get(k) ?? ''),
      heuristicLabel: clip(t.label, 100),
    };
  });
}
