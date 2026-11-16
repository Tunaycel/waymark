/**
 * "Sign in with GitHub" through the GitHub App's own OAuth credentials (user-to-server). The user
 * token is used once, at sign-in, to learn who the user is and which installations of this App
 * they can access; it is never stored.
 */

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** `https://github.com`, or `https://HOST` for GitHub Enterprise Server. */
  webUrl?: string;
  /** `https://api.github.com`, or `https://HOST/api/v3`. */
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export class OAuthError extends Error {
  /** Short, stable reason for logs and the sign-in page; never contains tokens or codes. */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'OAuthError';
    this.reason = reason;
  }
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** Where to send the browser to sign in. `state` must be random and checked on the way back. */
export function authorizeUrl(config: OAuthConfig, redirectUri: string, state: string): string {
  const url = new URL(`${trimSlash(config.webUrl ?? 'https://github.com')}/login/oauth/authorize`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  // A user who isn't signed in to GitHub may create an account on the way; we only read identity.
  url.searchParams.set('allow_signup', 'false');
  return url.toString();
}

async function call(config: OAuthConfig, url: string, init: RequestInit): Promise<Response> {
  const doFetch = config.fetch ?? fetch;
  try {
    return await doFetch(url, { ...init, signal: AbortSignal.timeout(config.timeoutMs ?? 10_000) });
  } catch {
    throw new OAuthError('github_unreachable', 'GitHub did not answer');
  }
}

/** Trades the one-time `code` from the redirect for a user access token. */
export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await call(
    config,
    `${trimSlash(config.webUrl ?? 'https://github.com')}/login/oauth/access_token`,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    },
  );
  // GitHub answers 200 with an `error` field for a bad or reused code.
  const body = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    error?: unknown;
  } | null;
  if (!res.ok || !body || typeof body.access_token !== 'string' || body.access_token === '') {
    const reason = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
    throw new OAuthError(reason.slice(0, 64), 'GitHub refused the sign-in code');
  }
  return body.access_token;
}

async function api<T>(config: OAuthConfig, token: string, path: string): Promise<T> {
  const res = await call(config, `${trimSlash(config.apiUrl ?? 'https://api.github.com')}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'waymark',
    },
  });
  if (!res.ok) throw new OAuthError(`api_${res.status}`, `GitHub answered ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new OAuthError('invalid_json', 'GitHub answered with something that is not JSON');
  }
}

export async function fetchUser(config: OAuthConfig, token: string): Promise<GitHubUser> {
  const u = await api<{ id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown }>(
    config,
    token,
    '/user',
  );
  if (typeof u.id !== 'number' || typeof u.login !== 'string') {
    throw new OAuthError('invalid_user', 'GitHub returned an unexpected user');
  }
  return {
    id: u.id,
    login: u.login,
    name: typeof u.name === 'string' ? u.name : null,
    avatarUrl: typeof u.avatar_url === 'string' ? u.avatar_url : null,
  };
}

/** Pages GitHub may return for installations; more than enough for one person's accounts. */
const MAX_INSTALLATION_PAGES = 10;

/** Installations of this App the user can access (their own account and orgs they belong to). */
export async function fetchUserInstallations(
  config: OAuthConfig,
  token: string,
): Promise<number[]> {
  const ids: number[] = [];
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    const body = await api<{ installations?: { id?: unknown }[] }>(
      config,
      token,
      `/user/installations?per_page=100&page=${page}`,
    );
    const list = Array.isArray(body.installations) ? body.installations : [];
    for (const i of list) if (typeof i.id === 'number') ids.push(i.id);
    if (list.length < 100) break;
  }
  return [...new Set(ids)];
}

/** Pages of repositories read per installation: 5,000 repositories. */
const MAX_REPOSITORY_PAGES = 50;

/**
 * GitHub ids of the repositories the user can access through this App: for each installation they
 * can see, only the repositories they themselves have access to. An organisation installation
 * with "all repositories" does not give a member its private repositories they can't open.
 */
export async function fetchUserRepositoryIds(
  config: OAuthConfig,
  token: string,
): Promise<number[]> {
  const ids = new Set<number>();
  for (const installation of await fetchUserInstallations(config, token)) {
    for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
      const body = await api<{ repositories?: { id?: unknown }[] }>(
        config,
        token,
        `/user/installations/${installation}/repositories?per_page=100&page=${page}`,
      );
      const list = Array.isArray(body.repositories) ? body.repositories : [];
      for (const r of list) if (typeof r.id === 'number' && r.id > 0) ids.add(r.id);
      if (list.length < 100) break;
    }
  }
  return [...ids];
}

/**
 * Invalidates the user token once sign-in is done: we never store it, so nothing should be able to
 * use it either. Best effort; GitHub expires it anyway.
 */
export async function revokeToken(config: OAuthConfig, token: string): Promise<void> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  try {
    await call(
      config,
      `${trimSlash(config.apiUrl ?? 'https://api.github.com')}/applications/${encodeURIComponent(config.clientId)}/token`,
      {
        method: 'DELETE',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Basic ${basic}`,
          'content-type': 'application/json',
          'user-agent': 'waymark',
        },
        body: JSON.stringify({ access_token: token }),
      },
    );
  } catch {
    // Unreachable GitHub: the token expires on its own.
  }
}

/**
 * `WAYMARK_ALLOWED_USERS`: comma or space separated GitHub logins, matched case-insensitively.
 * `_` is allowed for Enterprise Managed Users (`handle_shortcode`).
 */
export function parseAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim().replace(/^@/, '').toLowerCase())
      .filter((s) => /^[a-z0-9](?:[a-z0-9_-]{0,38})$/.test(s)),
  );
}
