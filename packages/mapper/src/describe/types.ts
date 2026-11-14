import { z } from 'zod';

/** What a topic is for, coarsely: lets the map colour and group nodes. */
export const TOPIC_ROLES = [
  'feature',
  'api',
  'ui',
  'data',
  'infrastructure',
  'integration',
  'tooling',
  'tests',
  'docs',
  'config',
  'other',
] as const;
export type TopicRole = (typeof TOPIC_ROLES)[number];

/** Everything a describer sees about one topic. Structure only: never file contents. */
export interface TopicBrief {
  id: string;
  /** Package root and its name/description from the manifest. */
  package: string;
  packageName: string | null;
  packageDescription: string | null;
  directory: string;
  /** Member paths relative to the package (at most 40). */
  files: string[];
  sourceFiles: number;
  testFiles: number;
  lines: number;
  languages: string[];
  symbols: string[];
  externals: string[];
  /** Heuristic labels of the topics this one imports / is imported by. */
  uses: string[];
  usedBy: string[];
  heuristicLabel: string;
}

export interface RepositoryBrief {
  name: string;
  description: string | null;
  readme: string | null;
  frameworks: string[];
}

export interface TopicDescription {
  id: string;
  name: string;
  summary: string;
  role: TopicRole;
}

export interface DescribeUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface DescribeResult {
  descriptions: TopicDescription[];
  usage: DescribeUsage;
}

export interface Describer {
  readonly provider: 'claude' | 'ollama';
  readonly model: string;
  /** Worst-case cost of one `describe` call, checked against the budget before calling. */
  estimateCostUsd(repo: RepositoryBrief, briefs: TopicBrief[]): number;
  describe(
    repo: RepositoryBrief,
    briefs: TopicBrief[],
    signal?: AbortSignal,
  ): Promise<DescribeResult>;
}

/**
 * The model's answer for a batch of topics. Its size is bounded by `max_tokens` (and budgeted at
 * that worst case); lengths are clipped and text sanitised when accepted.
 */
export const DescriptionBatchSchema = z.object({
  topics: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      summary: z.string(),
      role: z.enum(TOPIC_ROLES),
    }),
  ),
});
export type DescriptionBatch = z.infer<typeof DescriptionBatchSchema>;

export interface DescribeErrorOptions {
  /** Retrying this batch cannot help (refusal, invalid output, request too large). */
  permanent: boolean;
  /** Every later batch would fail the same way (bad key, provider down, model missing). */
  stopRun: boolean;
  /** What the failed call was billed, when it was billed at all. */
  usage?: DescribeUsage;
}

export class DescribeError extends Error {
  readonly permanent: boolean;
  readonly stopRun: boolean;
  readonly usage: DescribeUsage | undefined;

  constructor(message: string, { permanent, stopRun, usage }: DescribeErrorOptions) {
    super(message);
    this.name = 'DescribeError';
    this.permanent = permanent;
    this.stopRun = stopRun;
    this.usage = usage;
  }
}
