import { z } from 'zod';

const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/** Variables every process needs. */
const baseSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  LOG_LEVEL: logLevel.default('info'),
});

/** The HTTP server additionally receives GitHub webhooks. */
const serverSchema = baseSchema.extend({
  GITHUB_WEBHOOK_SECRET: z
    .string()
    .min(16, 'GITHUB_WEBHOOK_SECRET must be at least 16 characters; generate a random one'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  /** Proxy hops whose X-Forwarded-* headers are trusted. 0 = serve directly, trust none. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
});

/**
 * The worker can index repositories when GitHub App credentials are present. They are optional so
 * ingestion runs without them, but a half-configured App (one variable set) is an error.
 */
const workerSchema = baseSchema
  .extend({
    GITHUB_APP_ID: z.string().regex(/^\d+$/, 'GITHUB_APP_ID must be the numeric App ID').optional(),
    GITHUB_APP_PRIVATE_KEY: z
      .string()
      .includes('PRIVATE KEY', { message: 'GITHUB_APP_PRIVATE_KEY must be a PEM private key' })
      .optional(),
    GITHUB_API_URL: z.url({ protocol: /^https?$/ }).default('https://api.github.com'),
    /**
     * Who names topics: `auto` uses Claude when ANTHROPIC_API_KEY is set, else Ollama when
     * OLLAMA_MODEL is set, else heuristic labels only.
     */
    WAYMARK_LLM_PROVIDER: z.enum(['auto', 'claude', 'ollama', 'none']).default('auto'),
    ANTHROPIC_API_KEY: z.string().min(20, 'ANTHROPIC_API_KEY looks truncated').optional(),
    WAYMARK_LLM_MODEL: z.string().min(1).optional(),
    OLLAMA_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:11434'),
    OLLAMA_MODEL: z.string().min(1).optional(),
    /** Hard monthly cap on AI spend, in USD. 0 disables paid calls. */
    WAYMARK_LLM_MONTHLY_BUDGET_USD: z.coerce.number().min(0).max(10_000).default(2),
  })
  .refine(
    (env) => (env.GITHUB_APP_ID === undefined) === (env.GITHUB_APP_PRIVATE_KEY === undefined),
    {
      message: 'set both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, or neither',
      path: ['GITHUB_APP_PRIVATE_KEY'],
    },
  )
  .refine((env) => env.WAYMARK_LLM_PROVIDER !== 'claude' || env.ANTHROPIC_API_KEY, {
    message: 'WAYMARK_LLM_PROVIDER=claude needs ANTHROPIC_API_KEY',
    path: ['ANTHROPIC_API_KEY'],
  })
  .refine((env) => env.WAYMARK_LLM_PROVIDER !== 'ollama' || env.OLLAMA_MODEL, {
    message: 'WAYMARK_LLM_PROVIDER=ollama needs OLLAMA_MODEL (e.g. qwen3.5:4b)',
    path: ['OLLAMA_MODEL'],
  });

export type BaseEnv = z.infer<typeof baseSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;
export type WorkerEnv = z.infer<typeof workerSchema>;

/** Thrown when required configuration is missing or invalid. Lists every problem at once. */
export class EnvError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvError';
    this.issues = issues;
  }
}

function parse<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  // Treat empty strings as unset so `.env` files with `KEY=` fall back to defaults / fail clearly.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

export function loadBaseEnv(source: NodeJS.ProcessEnv = process.env): BaseEnv {
  return parse(baseSchema, source);
}

export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  return parse(serverSchema, source);
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return parse(workerSchema, source);
}
