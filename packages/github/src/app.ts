import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

export interface GitHubAppCredentials {
  appId: string;
  /** PEM private key from the App settings. Literal `\n` sequences (common in .env files) are accepted. */
  privateKey: string;
  /** `https://api.github.com`, or `https://HOST/api/v3` for GitHub Enterprise Server. */
  apiUrl?: string;
}

export interface GitHubAppOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Per-request timeout for API calls (not for tarball streaming). */
  requestTimeoutMs?: number;
}

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }

  /** Retrying cannot help: the repository or installation is gone or never was accessible. */
  get permanent(): boolean {
    return this.status === 404 || this.status === 410 || this.status === 451;
  }
}

export interface RepositoryInfo {
  githubId: number;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
}

/** `owner/name`; segments `.` and `..` are refused, they would rewrite the API URL path. */
const FULL_NAME = /^(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function loadPrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem.includes('\\n') ? pem.replaceAll('\\n', '\n') : pem);
}

const base64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

/**
 * App JWT (RS256), valid for 9 minutes. `iat` is backdated 60 s to tolerate clock drift, as GitHub
 * recommends; GitHub rejects tokens that expire more than 10 minutes out.
 */
export function createAppJwt(appId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${base64url(signature)}`;
}

function repoPath(fullName: string): string {
  if (!FULL_NAME.test(fullName)) throw new Error(`Invalid repository name: ${fullName}`);
  const [owner, repo] = fullName.split('/') as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** Talks to GitHub as a GitHub App installation: short-lived tokens, repository reads, tarballs. */
export class GitHubApp {
  private readonly appId: string;
  private readonly key: KeyObject;
  private readonly apiUrl: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly tokens = new Map<number, Promise<{ token: string; expiresAt: number }>>();

  constructor(credentials: GitHubAppCredentials, options: GitHubAppOptions = {}) {
    this.appId = credentials.appId;
    this.key = loadPrivateKey(credentials.privateKey);
    this.apiUrl = (credentials.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  /**
   * Installation access token (valid one hour). Cached until five minutes before expiry; concurrent
   * callers share one in-flight request.
   */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached) {
      try {
        const token = await cached;
        if (token.expiresAt - 5 * 60_000 > this.now()) return token.token;
      } catch {
        // fall through and request a fresh token
      }
    }
    const request = this.requestToken(installationId);
    this.tokens.set(installationId, request);
    try {
      return (await request).token;
    } catch (err) {
      this.tokens.delete(installationId);
      throw err;
    }
  }

  private async requestToken(installationId: number) {
    const jwt = createAppJwt(this.appId, this.key, this.now());
    const res = await this.call(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      authorization: `Bearer ${jwt}`,
    });
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token || !body.expires_at) {
      throw new GitHubApiError(res.status, 'Installation token response is missing fields');
    }
    return { token: body.token, expiresAt: Date.parse(body.expires_at) };
  }

  async getRepository(installationId: number, fullName: string): Promise<RepositoryInfo> {
    const res = await this.call(repoPath(fullName), {
      authorization: `token ${await this.installationToken(installationId)}`,
    });
    const body = (await res.json()) as {
      id: number;
      full_name: string;
      default_branch: string;
      private: boolean;
    };
    return {
      githubId: body.id,
      fullName: body.full_name,
      defaultBranch: body.default_branch,
      isPrivate: body.private,
    };
  }

  /** The commit SHA a branch, tag, or SHA currently points to. */
  async resolveRef(installationId: number, fullName: string, ref: string): Promise<string> {
    const res = await this.call(`${repoPath(fullName)}/commits/${encodeURIComponent(ref)}`, {
      authorization: `token ${await this.installationToken(installationId)}`,
      accept: 'application/vnd.github.sha',
    });
    const sha = (await res.text()).trim();
    if (!SHA.test(sha)) throw new GitHubApiError(res.status, `Unexpected SHA response for ${ref}`);
    return sha;
  }

  /**
   * Streams the gzipped tarball of a commit. GitHub answers with a redirect to a signed codeload
   * URL; `fetch` follows it and drops the Authorization header on the cross-origin hop.
   */
  async downloadTarball(
    installationId: number,
    fullName: string,
    sha: string,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!SHA.test(sha)) throw new Error(`Invalid commit SHA: ${sha}`);
    const res = await this.call(`${repoPath(fullName)}/tarball/${sha}`, {
      authorization: `token ${await this.installationToken(installationId)}`,
      signal,
    });
    if (!res.body) throw new GitHubApiError(res.status, 'Tarball response has no body');
    return res.body;
  }

  private async call(
    path: string,
    opts: {
      method?: string;
      authorization: string;
      accept?: string;
      signal?: AbortSignal | undefined;
    },
  ): Promise<Response> {
    const res = await this.fetch(`${this.apiUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        accept: opts.accept ?? 'application/vnd.github+json',
        authorization: opts.authorization,
        'user-agent': 'waymark',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'follow',
      // Streaming downloads use the caller's signal (a long overall budget); API calls time out fast.
      signal: opts.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new GitHubApiError(
        res.status,
        `GitHub ${opts.method ?? 'GET'} ${path} failed with ${res.status}: ${detail.slice(0, 200)}`,
      );
    }
    return res;
  }
}
