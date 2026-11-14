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
  })
  .refine(
    (env) => (env.GITHUB_APP_ID === undefined) === (env.GITHUB_APP_PRIVATE_KEY === undefined),
    {
      message: 'set both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, or neither',
      path: ['GITHUB_APP_PRIVATE_KEY'],
    },
  );

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
