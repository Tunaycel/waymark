/**
 * Loads a repository into the local database so the dashboard has real data, without a GitHub
 * App: index → snapshot → topics (→ AI names with --describe, within the monthly budget).
 *
 *   pnpm demo <path>                  a local folder; its recent git history becomes activity
 *   pnpm demo <owner/repo>            a public GitHub repository (anonymous tarball)
 *   pnpm demo <owner/repo> --github   GitHub even if a local folder has the same name
 *   pnpm demo <...> --describe        name topics with AI (WAYMARK_LLM_PROVIDER; costs cents)
 *
 * Demo repositories get negative ids, so they can never collide with real GitHub repositories.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadWorkerEnv } from '@waymark/core';
import {
  ALL_REPOSITORIES,
  commits,
  createDatabase,
  findRepository,
  findSnapshot,
  repositories,
  runMigrations,
  saveSnapshot,
  upsertRepository,
} from '@waymark/db';
import { indexIsolated, indexRepository, localSource } from '@waymark/indexer';
import { ClaudeDescriber, type Describer, OllamaDescriber } from '@waymark/mapper';
import { buildSnapshotTopics } from '@waymark/worker/topics';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';

const args = process.argv.slice(2).filter((a) => a !== '--');
const target = args.find((a) => !a.startsWith('--'));
if (!target) throw new Error('Usage: pnpm demo <path | owner/repo> [--github] [--describe]');
const describe = args.includes('--describe');
// The demo needs no Redis; everything else is validated exactly like the worker's configuration.
const env = loadWorkerEnv({ REDIS_URL: 'redis://127.0.0.1:6380', ...process.env });

const log = pino({ level: 'info', base: null, timestamp: false });
const cwd = process.env.INIT_CWD ?? process.cwd();
const local = resolve(cwd, target);
const isRepoName =
  /^[\w.-]+\/[\w.-]+$/.test(target) && !target.split('/').some((s) => s === '.' || s === '..');
const isLocal = !args.includes('--github') && existsSync(local) && statSync(local).isDirectory();
if (!isLocal && !isRepoName) throw new Error(`${target}: not a folder or owner/repo`);
if (isLocal && isRepoName) log.info(`${target}: using the local folder (add --github for GitHub)`);

/** Ids derive from what the repository is: its absolute path, or its GitHub name. */
const identity = isLocal ? `local:${local.toLowerCase()}` : `github:${target.toLowerCase()}`;
const digest = createHash('sha1').update(identity).digest('hex');
const demoId = -(Number.parseInt(digest.slice(0, 12), 16) % 2 ** 46) - 1;

const git = (...a: string[]) =>
  execFileSync('git', ['-C', local, '-c', 'core.quotePath=false', ...a], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
const inGit =
  isLocal &&
  (() => {
    try {
      return git('rev-parse', '--is-inside-work-tree').trim() === 'true';
    } catch {
      return false;
    }
  })();

const github = async (path: string, accept = 'application/vnd.github+json') => {
  const res = await fetch(`https://api.github.com/repos/${target}${path}`, {
    headers: { accept, 'user-agent': 'waymark-demo' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${target}: GitHub answered ${res.status}`);
  return res;
};

await runMigrations(env.DATABASE_URL);
const { db, close } = createDatabase(env.DATABASE_URL);
try {
  // Name: two folders called `app` must not share a map, so a taken name gets a short suffix.
  let fullName = isLocal ? `local/${basename(local) || 'root'}` : target;
  const existing = await findRepository(db, fullName, ALL_REPOSITORIES);
  if (existing && existing.githubId !== demoId) fullName = `${fullName}-${digest.slice(0, 6)}`;

  // Head commit and branch.
  let sha: string;
  let branch: string;
  if (inGit) {
    sha = git('rev-parse', 'HEAD').trim();
    branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  } else if (isLocal) {
    // Not a git checkout: a fresh pseudo-commit per run, so the folder is always re-indexed.
    log.warn(`${local}: not a git repository, so there is no history to show as activity`);
    sha = createHash('sha1').update(`${identity}:${Date.now()}`).digest('hex');
    branch = 'local';
  } else {
    branch = ((await (await github('')).json()) as { default_branch: string }).default_branch;
    sha = (
      await (
        await github(`/commits/${encodeURIComponent(branch)}`, 'application/vnd.github.sha')
      ).text()
    ).trim();
  }

  const repositoryId = await upsertRepository(db, {
    githubId: demoId,
    fullName,
    defaultBranch: branch,
    isPrivate: isLocal,
    installationId: null,
  });

  // Activity: the last 90 days of local history, as if each commit had been pushed when made.
  if (inGit) {
    // `--relative`: paths relative to the folder (and only inside it), like the index's paths.
    const out = git(
      'log',
      '--relative',
      '--since=90 days ago',
      '-n',
      '500',
      '--name-status',
      '--format=%x1e%H%x1f%an%x1f%aI%x1f%s',
    );
    const rows = out
      .split('\x1e')
      .filter((block) => block.trim())
      .map((block) => {
        const [header = '', ...lines] = block.split('\n');
        const [hash = '', author = '', date = '', subject = ''] = header.split('\x1f');
        const files = { added: [] as string[], removed: [] as string[], modified: [] as string[] };
        for (const line of lines) {
          const [status = '', ...paths] = line.split('\t');
          const path = paths.at(-1);
          if (!path) continue;
          if (status.startsWith('A')) files.added.push(path);
          else if (status.startsWith('D')) files.removed.push(path);
          else files.modified.push(path);
        }
        // Author dates can lie (future clocks); never let one look newer than now.
        const at = new Date(Math.min(new Date(date).getTime(), Date.now()));
        return {
          repositoryId,
          sha: hash,
          branch,
          message: subject,
          authorName: author,
          committedAt: at,
          ingestedAt: at,
          url: `https://example.invalid/${hash}`,
          files,
        };
      });
    for (let i = 0; i < rows.length; i += 500) {
      await db
        .insert(commits)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing();
    }
    log.info({ commits: rows.length }, 'recent history loaded');
    if (rows[0]) {
      await db
        .update(repositories)
        .set({ lastPushAt: rows[0].ingestedAt })
        .where(eq(repositories.id, repositoryId));
    }
  }

  // Index (remote content runs isolated, like in the worker).
  let snapshotId = (await findSnapshot(db, repositoryId, sha))?.id ?? null;
  if (!snapshotId) {
    const started = performance.now();
    let index: Awaited<ReturnType<typeof indexRepository>>;
    if (isLocal) {
      index = await indexRepository(localSource(local));
    } else {
      const res = await fetch(`https://codeload.github.com/${target}/tar.gz/${sha}`, {
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!res.ok || !res.body) throw new Error(`${target}: download failed with ${res.status}`);
      index = await indexIsolated(res.body as unknown as ReadableStream<Uint8Array>);
    }
    const saved = await saveSnapshot(db, repositoryId, sha, index);
    snapshotId = saved.snapshotId ?? (await findSnapshot(db, repositoryId, sha))?.id ?? null;
    log.info({ files: index.stats.files, ms: Math.round(performance.now() - started) }, 'indexed');
  }
  if (!snapshotId) throw new Error('snapshot was not stored');

  const outcome = await buildSnapshotTopics(
    {
      db,
      log,
      describer: describe ? describerFor(env) : null,
      monthlyBudgetUsd: env.WAYMARK_LLM_MONTHLY_BUDGET_USD,
    },
    snapshotId,
    fullName,
  );
  log.info({ repo: fullName, ...outcome }, 'ready: open the dashboard (pnpm web)');
} finally {
  await close();
}

/** Same choice as the worker: WAYMARK_LLM_PROVIDER, or Claude/Ollama by what is configured. */
function describerFor(e: typeof env): Describer | null {
  const provider =
    e.WAYMARK_LLM_PROVIDER === 'auto'
      ? e.ANTHROPIC_API_KEY
        ? 'claude'
        : e.OLLAMA_MODEL
          ? 'ollama'
          : 'none'
      : e.WAYMARK_LLM_PROVIDER;
  if (provider === 'claude' && e.ANTHROPIC_API_KEY) {
    return new ClaudeDescriber({
      apiKey: e.ANTHROPIC_API_KEY,
      ...(e.WAYMARK_LLM_MODEL ? { model: e.WAYMARK_LLM_MODEL } : {}),
    });
  }
  if (provider === 'ollama' && e.OLLAMA_MODEL) {
    return new OllamaDescriber({ model: e.OLLAMA_MODEL, baseUrl: e.OLLAMA_URL });
  }
  log.warn('--describe: no AI provider configured, keeping heuristic names');
  return null;
}
