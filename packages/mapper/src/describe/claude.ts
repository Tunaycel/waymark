import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { acceptDescriptions, estimateTokens, SYSTEM_PROMPT, userPrompt } from './prompt.ts';
import {
  DescribeError,
  type DescribeResult,
  type Describer,
  type DescribeUsage,
  DescriptionBatchSchema,
  type RepositoryBrief,
  type TopicBrief,
} from './types.ts';

interface Price {
  input: number;
  output: number;
  /** Rates for prompts above `longContextTokens`, where the model has a higher tier. */
  longContext?: { input: number; output: number };
}

/** USD per million tokens (Anthropic list prices). */
export const CLAUDE_PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, longContext: { input: 0.5, output: 2.5 } },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};
const LONG_CONTEXT_TOKENS = 100_000;
/** Unknown models are budgeted at the most expensive listed price, never at zero. */
const FALLBACK_PRICE: Price = { input: 4, output: 20 };

export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';
/** Room for naming a batch (~150 tokens per topic) plus the model's thinking at low effort. */
const MAX_OUTPUT_TOKENS = 8_000;
/** One request; a hung call must not hold the index queue for the SDK's default 10 minutes. */
const REQUEST_TIMEOUT_MS = 120_000;

/** The slice of the SDK client this describer uses; tests pass a fake. */
export interface ClaudeClient {
  messages: Pick<Anthropic['messages'], 'create'>;
}

export interface ClaudeDescriberOptions {
  apiKey?: string;
  model?: string;
  client?: ClaudeClient;
}

const FORMAT = zodOutputFormat(DescriptionBatchSchema);

export class ClaudeDescriber implements Describer {
  readonly provider = 'claude' as const;
  readonly model: string;
  private readonly client: ClaudeClient;
  private readonly price: Price;

  constructor({ apiKey, model = DEFAULT_CLAUDE_MODEL, client }: ClaudeDescriberOptions = {}) {
    this.model = model;
    this.client =
      client ??
      new Anthropic({ ...(apiKey ? { apiKey } : {}), timeout: REQUEST_TIMEOUT_MS, maxRetries: 2 });
    this.price = CLAUDE_PRICES[model] ?? FALLBACK_PRICE;
  }

  private cost(inputTokens: number, outputTokens: number): number {
    const rate =
      this.price.longContext && inputTokens > LONG_CONTEXT_TOKENS
        ? this.price.longContext
        : this.price;
    return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
  }

  estimateCostUsd(repo: RepositoryBrief, briefs: TopicBrief[]): number {
    const input = estimateTokens(SYSTEM_PROMPT) + estimateTokens(userPrompt(repo, briefs));
    return this.cost(input, MAX_OUTPUT_TOKENS);
  }

  async describe(
    repo: RepositoryBrief,
    briefs: TopicBrief[],
    signal?: AbortSignal,
  ): Promise<DescribeResult> {
    let response: Anthropic.Message;
    try {
      // `create`, not `parse`: the SDK's parse helper throws on malformed output and the billed
      // usage is lost with the exception. Parsing here keeps usage in hand in every outcome.
      response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt(repo, briefs) }],
          // Naming from structured facts is a light task; low effort keeps thinking (billed as
          // output) small.
          output_config: { effort: 'low', format: { type: FORMAT.type, schema: FORMAT.schema } },
        },
        signal ? { signal } : undefined,
      );
    } catch (err) {
      throw classify(err);
    }

    const usage = this.usageOf(response.usage);
    if (response.stop_reason === 'refusal') {
      throw new DescribeError('Claude declined to describe these topics', {
        permanent: true,
        stopRun: false,
        usage,
      });
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const batch = DescriptionBatchSchema.safeParse(parsed);
    if (!batch.success) {
      throw new DescribeError(
        `Claude returned no valid output (stop: ${response.stop_reason ?? 'unknown'})`,
        { permanent: true, stopRun: false, usage },
      );
    }
    return { descriptions: acceptDescriptions(batch.data, briefs), usage };
  }

  /**
   * Billed usage. If the API ever omits a count, the cost is charged at the request's worst case
   * rather than as zero (or NaN), so the budget can't be undercounted.
   */
  private usageOf(raw: Partial<Anthropic.Usage> | undefined): DescribeUsage {
    const count = (n: unknown) =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
    const input = count(raw?.input_tokens);
    const output = count(raw?.output_tokens);
    const cached =
      (count(raw?.cache_creation_input_tokens) ?? 0) + (count(raw?.cache_read_input_tokens) ?? 0);
    if (input === null || output === null) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: this.cost(LONG_CONTEXT_TOKENS, MAX_OUTPUT_TOKENS),
      };
    }
    return {
      inputTokens: input + cached,
      outputTokens: output,
      costUsd: this.cost(input + cached, output),
    };
  }
}

function classify(err: unknown): DescribeError {
  const message = err instanceof Error ? err.message : String(err);
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return new DescribeError(`Claude API rejected the key: ${message}`, {
      permanent: true,
      stopRun: true,
    });
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new DescribeError(`Claude model not found: ${message}`, {
      permanent: true,
      stopRun: true,
    });
  }
  if (err instanceof Anthropic.APIError && (err.status === 400 || err.status === 413)) {
    // This batch's request is unacceptable (e.g. too large); others may be fine.
    return new DescribeError(`Claude API rejected the request: ${message}`, {
      permanent: true,
      stopRun: false,
    });
  }
  // Rate limits, overload, outages, timeouts: later batches would fail the same way now.
  return new DescribeError(`Claude API call failed: ${message}`, {
    permanent: false,
    stopRun: true,
  });
}
