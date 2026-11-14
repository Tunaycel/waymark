import { z } from 'zod';
import { acceptDescriptions, SYSTEM_PROMPT, userPrompt } from './prompt.ts';
import {
  DescribeError,
  type DescribeResult,
  type Describer,
  DescriptionBatchSchema,
  type RepositoryBrief,
  type TopicBrief,
} from './types.ts';

export interface OllamaDescriberOptions {
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Local models are slower; a batch gets this long. */
  timeoutMs?: number;
}

const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);

/**
 * A local model through Ollama: free and private (nothing leaves the machine), lower quality than
 * Claude. Uses Ollama's JSON-schema constrained output.
 */
export class OllamaDescriber implements Describer {
  readonly provider = 'ollama' as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor({
    model,
    baseUrl = 'http://127.0.0.1:11434',
    fetch: f,
    timeoutMs = 300_000,
  }: OllamaDescriberOptions) {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = f ?? globalThis.fetch;
    this.timeoutMs = timeoutMs;
  }

  estimateCostUsd(): number {
    return 0;
  }

  async describe(
    repo: RepositoryBrief,
    briefs: TopicBrief[],
    signal?: AbortSignal,
  ): Promise<DescribeResult> {
    // The per-batch timeout always applies; a caller's signal can only end the call sooner.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          format: z.toJSONSchema(DescriptionBatchSchema),
          options: { temperature: 0 },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt(repo, briefs) },
          ],
        }),
        signal: combined,
      });
    } catch (err) {
      throw new DescribeError(`Ollama is not reachable: ${(err as Error).message}`, {
        permanent: false,
        stopRun: true,
      });
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      // 404: the model isn't pulled. Every batch would fail the same way.
      throw new DescribeError(`Ollama answered ${res.status}: ${detail}`, {
        permanent: res.status === 404,
        stopRun: true,
      });
    }

    let body: {
      message?: { content?: unknown };
      prompt_eval_count?: unknown;
      eval_count?: unknown;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new DescribeError('Ollama returned a body that is not JSON', {
        permanent: false,
        stopRun: true,
      });
    }
    const usage = {
      inputTokens: count(body.prompt_eval_count),
      outputTokens: count(body.eval_count),
      costUsd: 0,
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof body.message?.content === 'string' ? body.message.content : '');
    } catch {
      throw new DescribeError('Ollama returned text that is not JSON', {
        permanent: true,
        stopRun: false,
        usage,
      });
    }
    const batch = DescriptionBatchSchema.safeParse(parsed);
    if (!batch.success) {
      throw new DescribeError('Ollama returned JSON in the wrong shape', {
        permanent: true,
        stopRun: false,
        usage,
      });
    }
    return { descriptions: acceptDescriptions(batch.data, briefs), usage };
  }
}
