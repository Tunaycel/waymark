import { describe, expect, it } from 'vitest';
import {
  authorizeUrl,
  exchangeCode,
  fetchUser,
  fetchUserInstallations,
  fetchUserRepositoryIds,
  OAuthError,
  parseAllowlist,
  revokeToken,
} from './oauth.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { f, calls };
}

const base = { clientId: 'Iv1.abc', clientSecret: 'shh' };

describe('authorizeUrl', () => {
  it('carries the client id, redirect, and state', () => {
    const url = new URL(authorizeUrl(base, 'http://127.0.0.1:3100/auth/callback', 'st&ate'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('Iv1.abc');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3100/auth/callback');
    expect(url.searchParams.get('state')).toBe('st&ate');
  });

  it('uses an Enterprise host when configured', () => {
    expect(authorizeUrl({ ...base, webUrl: 'https://ghe.example/' }, 'r', 's')).toMatch(
      /^https:\/\/ghe\.example\/login\/oauth\/authorize\?/,
    );
  });
});

describe('exchangeCode', () => {
  it('returns the access token and sends the secret only in the body', async () => {
    const { f, calls } = fakeFetch(() => json({ access_token: 'ghu_token' }));
    await expect(exchangeCode({ ...base, fetch: f }, 'code1', 'r')).resolves.toBe('ghu_token');
    expect(calls[0]?.url).toBe('https://github.com/login/oauth/access_token');
    expect(calls[0]?.url).not.toContain('shh');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      code: 'code1',
      client_secret: 'shh',
    });
  });

  it("turns GitHub's 200-with-error into an OAuthError with its reason", async () => {
    const { f } = fakeFetch(() => json({ error: 'bad_verification_code' }));
    const err = await exchangeCode({ ...base, fetch: f }, 'reused', 'r').catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).reason).toBe('bad_verification_code');
  });

  it('reports an unreachable GitHub without leaking details', async () => {
    const f = (async () => {
      throw new Error('ECONNRESET secret');
    }) as unknown as typeof fetch;
    const err = await exchangeCode({ ...base, fetch: f }, 'c', 'r').catch((e) => e);
    expect((err as OAuthError).reason).toBe('github_unreachable');
    expect((err as Error).message).not.toContain('secret');
  });

  it('rejects a non-JSON answer', async () => {
    const { f } = fakeFetch(() => new Response('<html>', { status: 502 }));
    await expect(exchangeCode({ ...base, fetch: f }, 'c', 'r')).rejects.toBeInstanceOf(OAuthError);
  });
});

describe('user and installations', () => {
  it('reads the user with the bearer token', async () => {
    const { f, calls } = fakeFetch(() =>
      json({ id: 7, login: 'Tunaycel', name: null, avatar_url: 'x' }),
    );
    await expect(fetchUser({ ...base, fetch: f }, 'tok')).resolves.toEqual({
      id: 7,
      login: 'Tunaycel',
      name: null,
      avatarUrl: 'x',
    });
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
  });

  it('refuses a malformed user', async () => {
    const { f } = fakeFetch(() => json({ login: 'x' }));
    await expect(fetchUser({ ...base, fetch: f }, 't')).rejects.toBeInstanceOf(OAuthError);
  });

  it('pages through installations and de-duplicates', async () => {
    const { f, calls } = fakeFetch((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page === 1)
        return json({ installations: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) });
      return json({ installations: [{ id: 5 }, { id: 500 }, { id: 'bad' }] });
    });
    const ids = await fetchUserInstallations({ ...base, fetch: f }, 't');
    expect(ids).toHaveLength(101);
    expect(ids).toContain(500);
    expect(calls).toHaveLength(2);
  });

  it('stops after a bounded number of pages', async () => {
    let n = 0;
    const { f, calls } = fakeFetch(() =>
      json({ installations: Array.from({ length: 100 }, () => ({ id: ++n })) }),
    );
    await fetchUserInstallations({ ...base, fetch: f }, 't');
    expect(calls).toHaveLength(10);
  });
});

describe('parseAllowlist', () => {
  it('splits, lowercases, strips @, and drops invalid logins', () => {
    expect([...parseAllowlist(' Tunaycel, @Octo-Cat  bad.name,,-x ')]).toEqual([
      'tunaycel',
      'octo-cat',
    ]);
    expect(parseAllowlist(undefined).size).toBe(0);
  });
});

describe('repositories per installation and token revocation', () => {
  it('collects only the repositories the user can open, across installations', async () => {
    const { f, calls } = fakeFetch((url) => {
      const u = new URL(url);
      if (u.pathname === '/user/installations')
        return json({ installations: [{ id: 1 }, { id: 2 }] });
      if (u.pathname === '/user/installations/1/repositories')
        return json({ repositories: [{ id: 10 }, { id: 11 }] });
      return json({ repositories: [{ id: 11 }, { id: 20 }, { id: -3 }, { id: 'x' }] });
    });
    const ids = await fetchUserRepositoryIds({ ...base, fetch: f }, 't');
    expect(ids.sort((a, b) => a - b)).toEqual([10, 11, 20]);
    expect(calls.map((c) => new URL(c.url).pathname)).toContain(
      '/user/installations/2/repositories',
    );
  });

  it('revokes the token with the client credentials, and never throws', async () => {
    const { f, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await revokeToken({ ...base, fetch: f }, 'ghu_x');
    expect(calls[0]?.url).toBe('https://api.github.com/applications/Iv1.abc/token');
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ access_token: 'ghu_x' });
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(revokeToken({ ...base, fetch: down }, 't')).resolves.toBeUndefined();
  });

  it('wraps a non-JSON API answer in an OAuthError', async () => {
    const { f } = fakeFetch(() => new Response('<html>', { status: 200 }));
    await expect(fetchUser({ ...base, fetch: f }, 't')).rejects.toBeInstanceOf(OAuthError);
  });

  it('accepts Enterprise Managed User logins with an underscore', () => {
    expect([...parseAllowlist('octo_shortcode')]).toEqual(['octo_shortcode']);
  });
});
