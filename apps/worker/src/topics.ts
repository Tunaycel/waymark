import {
  type Database,
  databaseLedger,
  loadRepositoryTopics,
  loadSnapshotForTopics,
  pruneRepositoryTopics,
  saveTopics,
  type TopicToSave,
  withAdvisoryLock,
} from '@waymark/db';
import {
  assignIdentities,
  buildTopicsIsolated,
  type Describer,
  describeTopics,
  jaccard,
  PROMPT_VERSION,
  repositoryBrief,
  type TopicMap,
  topicBriefs,
} from '@waymark/mapper';
import type { Logger } from 'pino';

export interface TopicDeps {
  db: Database;
  log: Logger;
  /** `null`: topics get heuristic labels only. */
  describer: Describer | null;
  monthlyBudgetUsd: number;
  /** Overall budget for naming one snapshot's topics; what's left keeps heuristic names. */
  describeTimeoutMs?: number;
  /** Builds topics; defaults to an isolated process. Tests may pass an in-process builder. */
  build?: (input: Parameters<typeof buildTopicsIsolated>[0]) => Promise<TopicMap>;
}

export interface TopicOutcome {
  topics: number;
  described: number;
  reused: number;
  heuristic: number;
  spentUsd: number;
  stoppedBy: 'budget' | 'error' | 'aborted' | null;
}

/** A description is kept until its topic's membership or content has drifted this far. */
const REUSE_MIN_SIMILARITY = 0.7;
const REUSE_MAX_CHANGED = 0.5;
/** All AI spending, across worker processes, is checked and recorded under this one lock. */
const BUDGET_LOCK = 'waymark:llm-budget';

/**
 * Builds the topics of a stored snapshot: cluster (isolated process) → stable ids → reuse
 * descriptions that still fit → describe the rest within the monthly budget → store.
 *
 * One build per repository at a time (advisory lock), so a retried or duplicated job can't pay for
 * the same descriptions twice or interleave writes. Provider failures never fail the build;
 * undescribed topics keep their heuristic labels and are retried on the next build.
 */
export async function buildSnapshotTopics(
  deps: TopicDeps,
  snapshotId: string,
  repositoryName: string,
): Promise<TopicOutcome | null> {
  const snapshot = await loadSnapshotForTopics(deps.db, snapshotId);
  if (!snapshot) return null;
  return withAdvisoryLock(deps.db, `waymark:topics:${snapshot.repositoryId}`, () =>
    build(deps, snapshot, repositoryName),
  );
}

async function build(
  deps: TopicDeps,
  snapshot: NonNullable<Awaited<ReturnType<typeof loadSnapshotForTopics>>>,
  repositoryName: string,
): Promise<TopicOutcome> {
  const { repositoryId } = snapshot;
  // Summaries written by older versions may lack newer fields.
  const summary = snapshot.summary;
  const manifests = summary.manifests ?? [];

  const map = await (deps.build ?? buildTopicsIsolated)({
    files: snapshot.files,
    edges: snapshot.edges,
    manifests,
  });
  const known = await loadRepositoryTopics(deps.db, repositoryId);
  const identities = assignIdentities(
    map.topics,
    known.map((k) => ({ id: k.topicId, files: k.members })),
  );
  const knownById = new Map(known.map((k) => [k.topicId, k]));
  const blobOf = new Map(snapshot.files.map((f) => [f.path, f.blobSha]));

  const ids = new Map([...identities].map(([key, v]) => [key, v.id]));
  const reusable = new Map<string, { name: string; summary: string; role: string }>();
  for (const topic of map.topics) {
    const id = ids.get(topic.key) as string;
    const prior = knownById.get(id);
    if (!prior?.name || !prior.summary || !prior.describedBlobs) continue;
    if (prior.promptVersion !== PROMPT_VERSION) continue;
    if (deps.describer && prior.model !== deps.describer.model) continue;
    const before = prior.describedBlobs;
    if (jaccard(new Set(Object.keys(before)), new Set(topic.files)) < REUSE_MIN_SIMILARITY)
      continue;
    const shared = topic.files.filter((f) => Object.hasOwn(before, f));
    // A file whose content hash is unknown (not read) counts as changed: no evidence it isn't.
    const changed = shared.filter((f) => {
      const now = blobOf.get(f) ?? null;
      return now === null || before[f] === null || before[f] !== now;
    }).length;
    if (shared.length > 0 && changed / shared.length > REUSE_MAX_CHANGED) continue;
    reusable.set(id, { name: prior.name, summary: prior.summary, role: prior.role ?? 'other' });
  }

  const briefs = topicBriefs(map, ids, manifests).filter((b) => !reusable.has(b.id));
  let run: Awaited<ReturnType<typeof describeTopics>> | null = null;
  if (deps.describer && briefs.length > 0) {
    const describer = deps.describer;
    run = await withAdvisoryLock(deps.db, BUDGET_LOCK, () =>
      describeTopics(repositoryBrief(repositoryName, summary), briefs, {
        describer,
        ledger: databaseLedger(deps.db, repositoryId),
        monthlyBudgetUsd: deps.monthlyBudgetUsd,
        signal: AbortSignal.timeout(deps.describeTimeoutMs ?? 10 * 60_000),
        onBatchError: (err, batch) =>
          deps.log.warn(
            { err, repo: repositoryName, topics: batch.length },
            'topic description failed',
          ),
      }),
    );
  }

  const toSave: TopicToSave[] = map.topics.map((t) => {
    const id = ids.get(t.key) as string;
    const fresh = run?.descriptions.get(id) ?? null;
    const description = fresh ?? reusable.get(id) ?? null;
    return {
      topicId: id,
      package: t.package,
      directory: t.directory,
      files: t.files,
      label: t.label,
      keywords: t.keywords,
      externals: t.externals,
      languages: t.languages,
      sourceFiles: t.sourceFiles,
      testFiles: t.testFiles,
      lines: t.lines,
      description,
      freshDescription:
        fresh && deps.describer
          ? {
              provider: deps.describer.provider,
              model: deps.describer.model,
              promptVersion: PROMPT_VERSION,
              blobs: Object.fromEntries(t.files.map((f) => [f, blobOf.get(f) ?? null])),
            }
          : null,
    };
  });
  const edges = map.edges.map((e) => ({
    from: ids.get(e.from) as string,
    to: ids.get(e.to) as string,
    weight: e.weight,
  }));
  await saveTopics(deps.db, snapshot.id, repositoryId, toSave, edges);
  await pruneRepositoryTopics(deps.db, repositoryId);

  const outcome: TopicOutcome = {
    topics: map.topics.length,
    described: run?.descriptions.size ?? 0,
    reused: reusable.size,
    heuristic: toSave.filter((t) => !t.description).length,
    spentUsd: run?.spentUsd ?? 0,
    stoppedBy: run?.stoppedBy ?? null,
  };
  deps.log.info({ repo: repositoryName, snapshotId: snapshot.id, ...outcome }, 'topics built');
  if (outcome.stoppedBy === 'budget') {
    deps.log.warn(
      { repo: repositoryName, budgetUsd: deps.monthlyBudgetUsd },
      'monthly AI budget reached: remaining topics keep heuristic names until next month',
    );
  }
  return outcome;
}
