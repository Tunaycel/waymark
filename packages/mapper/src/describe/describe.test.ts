import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { type ClaudeClient, ClaudeDescriber } from './claude.ts';
import { OllamaDescriber } from './ollama.ts';
import { acceptDescriptions, estimateTokens, sanitize } from './prompt.ts';
import { describeTopics, InMemoryLedger, repositoryBrief } from './run.ts';
import { DescribeError, type Describer, type RepositoryBrief, type TopicBrief } from './types.ts';

/** A character by code point: keeps invisible characters out of the source. */
const c = (code: number) => String.fromCharCode(code);

const repo: RepositoryBrief = {
  name: 'octo/shop',
  description: 'A shop',
  readme: null,
  frameworks: [],
};
const brief = (id: string): TopicBrief => ({
  id,
  package: '',
  packageName: 'shop',
  packageDescription: null,
  directory: 'src/billing',
  files: ['src/billing/invoice.ts'],
  sourceFiles: 1,
  testFiles: 0,
  lines: 10,
  languages: ['TypeScript'],
  symbols: ['createInvoice'],
  externals: ['stripe'],
  uses: [],
  usedBy: [],
  heuristicLabel: 'Billing',
});
const answer = (id: string) => ({
  id,
  name: `Name ${id}`,
  summary: `Summary ${id}.`,
  role: 'feature' as const,
});

/** A Messages API response the way the real API returns it. */
function message(text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1_000, output_tokens: 200 },
    ...overrides,
  };
}

function fakeClaude(respond: () => unknown) {
  const create = vi.fn(async () => respond());
  return { client: { messages: { create } } as unknown as ClaudeClient, create };
}

describe('ClaudeDescriber', () => {
  it('sends structure, asks for structured output at low effort, and prices the usage', async () => {
    const { client, create } = fakeClaude(() =>
      message(JSON.stringify({ topics: [answer('t1')] })),
    );
    const result = await new ClaudeDescriber({ client }).describe(repo, [brief('t1')]);

    expect(result.descriptions).toEqual([answer('t1')]);
    // Haiku 5.5: $0.10 / $0.50 per million tokens.
    expect(result.usage.costUsd).toBeCloseTo((1_000 * 0.1 + 200 * 0.5) / 1e6, 10);
    const params = (create.mock.calls as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(params.model).toBe('claude-haiku-5-5');
    expect(params.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
    expect(JSON.stringify(params.messages)).toContain('createInvoice');
  });

  it('counts cached input tokens in the cost', async () => {
    const { client } = fakeClaude(() =>
      message('{"topics":[]}', {
        usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 0 },
      }),
    );
    const result = await new ClaudeDescriber({ client }).describe(repo, [brief('t1')]);
    expect(result.usage.inputTokens).toBe(1_000);
  });

  it.each([
    ['a refusal', message('I cannot help with that.', { stop_reason: 'refusal' })],
    [
      'output cut off at max_tokens',
      message('{"topics":[{"id":"t1","na', { stop_reason: 'max_tokens' }),
    ],
    [
      'JSON in the wrong shape',
      message('{"topics":[{"id":"t1","name":"x","summary":"y","role":"BOGUS"}]}'),
    ],
    ['prose instead of JSON', message('Here are your topics: ...')],
  ])('%s is a permanent batch failure that still carries the billed usage', async (_n, reply) => {
    const { client } = fakeClaude(() => reply);
    const err = await new ClaudeDescriber({ client }).describe(repo, [brief('t1')]).catch((e) => e);
    expect(err).toBeInstanceOf(DescribeError);
    expect(err).toMatchObject({ permanent: true, stopRun: false });
    expect(err.usage.costUsd).toBeGreaterThan(0);
  });

  it('charges the worst case when the API omits token counts (never NaN or zero)', async () => {
    const { client } = fakeClaude(() => message('{"topics":[]}', { usage: { input_tokens: 5 } }));
    const result = await new ClaudeDescriber({ client }).describe(repo, [brief('t1')]);
    expect(Number.isFinite(result.usage.costUsd)).toBe(true);
    expect(result.usage.costUsd).toBeGreaterThan(0.004);
  });

  it('classifies API errors: bad key stops the run, a too-large request skips the batch', async () => {
    const throwing = (error: unknown) =>
      ({
        messages: { create: vi.fn(async () => Promise.reject(error)) },
      }) as unknown as ClaudeClient;
    const headers = new Headers();
    const auth = new Anthropic.AuthenticationError(401, { type: 'error' }, 'bad key', headers);
    const tooLarge = Anthropic.APIError.generate(413, { type: 'error' }, 'too large', headers);
    const overloaded = Anthropic.APIError.generate(529, { type: 'error' }, 'overloaded', headers);

    const attempt = (e: unknown) =>
      new ClaudeDescriber({ client: throwing(e) }).describe(repo, [brief('t1')]).catch((x) => x);
    expect(await attempt(auth)).toMatchObject({ permanent: true, stopRun: true });
    expect(await attempt(tooLarge)).toMatchObject({ permanent: true, stopRun: false });
    expect(await attempt(overloaded)).toMatchObject({ permanent: false, stopRun: true });
    expect((await attempt('weird')).message).toContain('weird');
  });

  it('budgets unknown models at the most expensive price, and long prompts at the higher tier', () => {
    const { client } = fakeClaude(() => ({}));
    const haiku = new ClaudeDescriber({ client });
    const unknown = new ClaudeDescriber({ client, model: 'claude-future-9' });
    expect(unknown.estimateCostUsd(repo, [brief('t1')])).toBeGreaterThan(
      haiku.estimateCostUsd(repo, [brief('t1')]) * 10,
    );
    const huge = { ...repo, readme: 'x'.repeat(400_000) };
    // > 100K input tokens: Haiku's long-context rate ($0.50 / $2.50) applies.
    expect(haiku.estimateCostUsd(huge, [brief('t1')])).toBeGreaterThan(0.06);
  });
});

describe('OllamaDescriber', () => {
  const ollama = (fetch: unknown, timeoutMs?: number) =>
    new OllamaDescriber({
      model: 'qwen3.5:4b',
      fetch: fetch as typeof globalThis.fetch,
      ...(timeoutMs ? { timeoutMs } : {}),
    });

  it('calls the local chat API with a JSON schema and validates the reply', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.format.type).toBe('object');
      return new Response(
        JSON.stringify({
          message: { content: JSON.stringify({ topics: [answer('t1')] }) },
          prompt_eval_count: 500,
          eval_count: 80,
        }),
      );
    });
    const result = await ollama(fetch).describe(repo, [brief('t1')]);
    expect(result.descriptions).toEqual([answer('t1')]);
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 80, costUsd: 0 });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11434/api/chat');
  });

  it('rejects non-JSON and wrongly shaped replies per batch; odd counts become zero', async () => {
    for (const content of ['not json', JSON.stringify({ wrong: true })]) {
      const fetch = vi.fn(
        async () => new Response(JSON.stringify({ message: { content }, eval_count: 'lots' })),
      );
      await expect(ollama(fetch).describe(repo, [brief('t1')])).rejects.toMatchObject({
        permanent: true,
        stopRun: false,
        usage: { outputTokens: 0 },
      });
    }
  });

  it('a missing model or a non-JSON body stops the run instead of failing every batch', async () => {
    const missing = vi.fn(async () => new Response('model not found', { status: 404 }));
    await expect(ollama(missing).describe(repo, [brief('t1')])).rejects.toMatchObject({
      stopRun: true,
    });
    const html = vi.fn(async () => new Response('<html>proxy error</html>'));
    await expect(ollama(html).describe(repo, [brief('t1')])).rejects.toMatchObject({
      stopRun: true,
    });
  });

  it('keeps its own timeout even when the caller passes a signal', async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const started = performance.now();
    await expect(
      ollama(hang, 100).describe(repo, [brief('t1')], new AbortController().signal),
    ).rejects.toBeInstanceOf(DescribeError);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('acceptDescriptions and sanitize', () => {
  it('keeps only requested ids, once, and clips overlong text', () => {
    const out = acceptDescriptions(
      {
        topics: [
          answer('t1'),
          { ...answer('t1'), name: 'duplicate' },
          answer('not-asked'),
          { id: 't2', name: 'x'.repeat(500), summary: 'y'.repeat(2_000), role: 'api' },
          { id: 't3', name: '   ', summary: 'empty name', role: 'api' },
          { id: '__proto__', name: 'n', summary: 's', role: 'api' },
        ],
      },
      [brief('t1'), brief('t2'), brief('t3')],
    );
    expect(out.map((d) => d.id)).toEqual(['t1', 't2']);
    expect(Array.from(out[1]?.name ?? '').length).toBe(48);
    expect(Array.from(out[1]?.summary ?? '').length).toBe(280);
  });

  it('removes what must not be stored or shown: NUL, controls, bidi overrides, links, markup', () => {
    const hostile = `Auth${c(0)}Core${c(0x1b)}[31m ${c(0x202e)}evil <script>x</script> [click](https://evil.example/x) \`code\` ${c(0xd800)}ok`;
    const clean = sanitize(hostile, 280);
    for (const bad of [c(0), c(0x1b), c(0x202e), '`', '<', '>', '[', ']'])
      expect(clean).not.toContain(bad);
    expect(clean).not.toContain('https://');
    expect(clean.isWellFormed()).toBe(true);
    expect(sanitize('snake_case and C# stay', 280)).toBe('snake_case and C# stay');
  });

  it('rejects names with no letters or digits (zero-width, punctuation only)', () => {
    const out = acceptDescriptions(
      { topics: [{ id: 't1', name: c(0x200b).repeat(2), summary: 'ok summary', role: 'api' }] },
      [brief('t1')],
    );
    expect(out).toEqual([]);
  });

  it('estimates tokens conservatively for non-ASCII text', () => {
    expect(estimateTokens('字'.repeat(10_000))).toBeGreaterThanOrEqual(10_000);
  });
});

describe('describeTopics', () => {
  const fakeDescriber = (overrides: Partial<Describer> = {}): Describer => ({
    provider: 'claude',
    model: 'fake',
    estimateCostUsd: () => 0.01,
    describe: async (_repo, briefs) => ({
      descriptions: briefs.map((b) => answer(b.id)),
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.004 },
    }),
    ...overrides,
  });
  const many = (n: number) => Array.from({ length: n }, (_, i) => brief(`t${i}`));

  it('describes in batches and records what each batch cost', async () => {
    const ledger = new InMemoryLedger();
    const run = await describeTopics(repo, many(20), {
      describer: fakeDescriber(),
      ledger,
      monthlyBudgetUsd: 1,
      batchSize: 8,
    });
    expect(run.descriptions.size).toBe(20);
    expect(ledger.entries).toHaveLength(3);
    expect(run.spentUsd).toBeCloseTo(0.012);
    expect(run.stoppedBy).toBeNull();
  });

  it('stops before a batch that could exceed the monthly budget', async () => {
    const ledger = new InMemoryLedger();
    ledger.spent = 0.987; // spent earlier this month: room for one more batch, not two
    const run = await describeTopics(repo, [brief('t1'), brief('t2')], {
      describer: fakeDescriber(),
      ledger,
      monthlyBudgetUsd: 1,
      batchSize: 1,
      concurrency: 1,
    });
    expect(run.descriptions.size).toBe(1);
    expect(run.missing).toEqual(['t2']);
    expect(run.stoppedBy).toBe('budget');
    expect(ledger.spent).toBeLessThanOrEqual(1);
  });

  it('never overshoots with parallel requests, even when the ledger is slow to read', async () => {
    // Reproduces the review finding: a stale ledger read let three $1 batches into a $2 budget.
    let reads = 0;
    const ledger = new InMemoryLedger();
    const slowLedger = {
      spentThisMonthUsd: async () => {
        reads++;
        await new Promise((r) => setTimeout(r, 20));
        return ledger.spent;
      },
      record: (e: Parameters<InMemoryLedger['record']>[0]) => ledger.record(e),
    };
    const dollar = fakeDescriber({
      estimateCostUsd: () => 1,
      describe: async (_repo, briefs) => {
        await new Promise((r) => setTimeout(r, 5));
        return {
          descriptions: briefs.map((b) => answer(b.id)),
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 1 },
        };
      },
    });
    const run = await describeTopics(repo, many(10), {
      describer: dollar,
      ledger: slowLedger,
      monthlyBudgetUsd: 2,
      batchSize: 1,
      concurrency: 4,
    });
    expect(ledger.spent).toBeLessThanOrEqual(2);
    expect(run.descriptions.size).toBe(2);
    expect(reads).toBe(1);
  });

  it('treats a NaN, negative, or missing cost as the worst case, never as free', async () => {
    for (const costUsd of [Number.NaN, -10]) {
      const ledger = new InMemoryLedger();
      const lying = fakeDescriber({
        estimateCostUsd: () => 0.3,
        describe: async (_repo, briefs) => ({
          descriptions: briefs.map((b) => answer(b.id)),
          usage: { inputTokens: 1, outputTokens: 1, costUsd },
        }),
      });
      const run = await describeTopics(repo, many(10), {
        describer: lying,
        ledger,
        monthlyBudgetUsd: 1,
        batchSize: 1,
        concurrency: 1,
      });
      expect(run.descriptions.size).toBe(3);
      expect(ledger.spent).toBeCloseTo(0.9);
    }
    const badEstimate = await describeTopics(repo, many(3), {
      describer: fakeDescriber({ estimateCostUsd: () => Number.NaN }),
      ledger: new InMemoryLedger(),
      monthlyBudgetUsd: 5,
    });
    expect(badEstimate).toMatchObject({ stoppedBy: 'error' });
    expect(badEstimate.descriptions.size).toBe(0);
  });

  it('records refused or malformed calls (they were billed) and continues with other batches', async () => {
    const ledger = new InMemoryLedger();
    let call = 0;
    const flaky = fakeDescriber({
      describe: async (_repo, briefs) => {
        call++;
        if (call === 1) {
          throw new DescribeError('declined', {
            permanent: true,
            stopRun: false,
            usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.002 },
          });
        }
        return {
          descriptions: briefs.map((b) => answer(b.id)),
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
        };
      },
    });
    const run = await describeTopics(repo, [brief('a'), brief('b')], {
      describer: flaky,
      ledger,
      monthlyBudgetUsd: 1,
      batchSize: 1,
      concurrency: 1,
    });
    expect(run.missing).toEqual(['a']);
    expect(run.stoppedBy).toBeNull();
    expect(ledger.spent).toBeCloseTo(0.003);
  });

  it('stops on run-wide failures, and charges an unexpected exception at the worst case', async () => {
    const errors: string[][] = [];
    const down = fakeDescriber({
      describe: async () => {
        throw new DescribeError('Ollama is not reachable', { permanent: false, stopRun: true });
      },
    });
    const run = await describeTopics(repo, [brief('a'), brief('b')], {
      describer: down,
      ledger: new InMemoryLedger(),
      monthlyBudgetUsd: 1,
      batchSize: 1,
      concurrency: 1,
      onBatchError: (_e, ids) => errors.push(ids),
    });
    expect(run.stoppedBy).toBe('error');
    expect(errors).toEqual([['a']]);

    const ledger = new InMemoryLedger();
    const crashing = fakeDescriber({
      describe: async () => {
        throw new TypeError('boom');
      },
    });
    await describeTopics(repo, [brief('a')], { describer: crashing, ledger, monthlyBudgetUsd: 1 });
    expect(ledger.spent).toBeCloseTo(0.01);
  });

  it('does not throw when the ledger fails, and keeps descriptions it already paid for', async () => {
    const unreadable = {
      spentThisMonthUsd: async () => Promise.reject(new Error('db down')),
      record: async () => {},
    };
    const r1 = await describeTopics(repo, many(2), {
      describer: fakeDescriber(),
      ledger: unreadable,
      monthlyBudgetUsd: 1,
    });
    expect(r1).toMatchObject({ stoppedBy: 'error' });

    const unwritable = {
      spentThisMonthUsd: async () => 0,
      record: async () => Promise.reject(new Error('insert failed')),
    };
    const r2 = await describeTopics(repo, many(16), {
      describer: fakeDescriber(),
      ledger: unwritable,
      monthlyBudgetUsd: 1,
      batchSize: 8,
      concurrency: 1,
    });
    expect(r2.stoppedBy).toBe('error');
    expect(r2.descriptions.size).toBe(8); // the paid batch is kept; no further spending
  });

  it('ignores descriptions for ids it did not ask about, and survives silly options', async () => {
    const injecting = fakeDescriber({
      describe: async (_repo, briefs) => ({
        descriptions: [...briefs.map((b) => answer(b.id)), answer('INJECTED')],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      }),
    });
    const run = await describeTopics(repo, many(3), {
      describer: injecting,
      ledger: new InMemoryLedger(),
      monthlyBudgetUsd: 1,
      batchSize: 0,
      concurrency: Number.NaN,
    });
    expect([...run.descriptions.keys()].sort()).toEqual(['t0', 't1', 't2']);
  });

  it('stops when the overall signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await describeTopics(repo, many(3), {
      describer: fakeDescriber(),
      ledger: new InMemoryLedger(),
      monthlyBudgetUsd: 1,
      signal: controller.signal,
    });
    expect(run).toMatchObject({ stoppedBy: 'aborted' });
    expect(run.descriptions.size).toBe(0);
  });

  it('builds a repository brief from summaries written before READMEs were indexed', () => {
    expect(repositoryBrief('octo/old', { manifests: [], frameworks: [] })).toEqual({
      name: 'octo/old',
      description: null,
      readme: null,
      frameworks: [],
    });
  });
});
