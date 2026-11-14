import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAppJwt, GitHubApiError, GitHubApp, loadPrivateKey } from './app.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

type Call = { url: string; init: RequestInit };

function fakeGitHub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tokenResponse = (n = 1) =>
  json({ token: `ghs_token${n}`, expires_at: new Date(NOW + 60 * 60_000).toISOString() }, 201);

const header = (call: Call | undefined, name: string) => new Headers(call?.init.headers).get(name);

describe('createAppJwt', () => {
  it('produces an RS256 JWT GitHub accepts: backdated iat, 9 minute expiry, App id as issuer', () => {
    const jwt = createAppJwt('12345', loadPrivateKey(pem), NOW);
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      iat: NOW / 1000 - 60,
      exp: NOW / 1000 + 540,
      iss: '12345',
    });
    const valid = createVerify('RSA-SHA256')
      .update(`${h}.${p}`)
      .verify(publicKey, Buffer.from(s, 'base64url'));
    expect(valid).toBe(true);
  });

  it('accepts keys with escaped newlines, as they appear in .env files', () => {
    expect(() => loadPrivateKey(pem.replaceAll('\n', '\\n'))).not.toThrow();
    expect(() => loadPrivateKey('not a key')).toThrow();
  });
});

describe('GitHubApp', () => {
  it('exchanges the App JWT for an installation token and caches it', async () => {
    const gh = fakeGitHub(() => tokenResponse());
    const app = new GitHubApp({ appId: '1', privateKey: pem }, { fetch: gh.fetch, now: () => NOW });

    expect(await app.installationToken(42)).toBe('ghs_token1');
    expect(await app.installationToken(42)).toBe('ghs_token1');
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]?.url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(gh.calls[0]?.init.method).toBe('POST');
    expect(header(gh.calls[0], 'authorization')).toMatch(/^Bearer ey/);
  });

  it('shares one in-flight token request between concurrent callers', async () => {
    const gh = fakeGitHub(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return tokenResponse();
    });
    const app = new GitHubApp({ appId: '1', privateKey: pem }, { fetch: gh.fetch, now: () => NOW });
    await Promise.all([
      app.installationToken(7),
      app.installationToken(7),
      app.installationToken(7),
    ]);
    expect(gh.calls).toHaveLength(1);
  });

  it('refreshes a token five minutes before it expires', async () => {
    let n = 0;
    let now = NOW;
    const gh = fakeGitHub(() => tokenResponse(++n));
    const app = new GitHubApp({ appId: '1', privateKey: pem }, { fetch: gh.fetch, now: () => now });
    expect(await app.installationToken(1)).toBe('ghs_token1');
    now = NOW + 56 * 60_000;
    expect(await app.installationToken(1)).toBe('ghs_token2');
  });

  it('does not cache a failed token request', async () => {
    let fail = true;
    const gh = fakeGitHub(() =>
      fail ? json({ message: 'Bad credentials' }, 401) : tokenResponse(),
    );
    const app = new GitHubApp({ appId: '1', privateKey: pem }, { fetch: gh.fetch, now: () => NOW });
    await expect(app.installationToken(1)).rejects.toMatchObject({ status: 401 });
    fail = false;
    expect(await app.installationToken(1)).toBe('ghs_token1');
  });

  it('reads repository metadata and resolves a ref to a commit SHA', async () => {
    const sha = 'a'.repeat(40);
    const gh = fakeGitHub((url) => {
      if (url.endsWith('/access_tokens')) return tokenResponse();
      if (url.endsWith('/repos/octo/demo')) {
        return json({ id: 99, full_name: 'octo/demo', default_branch: 'trunk', private: true });
      }
      if (url.endsWith('/repos/octo/demo/commits/trunk')) return new Response(`${sha}\n`);
      return json({ message: 'Not Found' }, 404);
    });
    const app = new GitHubApp({ appId: '1', privateKey: pem }, { fetch: gh.fetch, now: () => NOW });

    expect(await app.getRepository(5, 'octo/demo')).toEqual({
      githubId: 99,
      fullName: 'octo/demo',
      defaultBranch: 'trunk',
      isPrivate: true,
    });
    expect(await app.resolveRef(5, 'octo/demo', 'trunk')).toBe(sha);
    const commitCall = gh.calls.find((c) => c.url.includes('/commits/'));
    expect(header(commitCall, 'accept')).toBe('application/vnd.github.sha');
    expect(header(commitCall, 'authorization')).toBe('token ghs_token1');
  });

  it('streams a tarball for a commit', async () => {
    const gh = fakeGitHub((url) =>
      url.endsWith('/access_tokens') ? tokenResponse() : new Response(new Uint8Array([1, 2, 3])),
    );
    const app = new GitHubApp({ appId: '1', privateKey: pem }, { fetch: gh.fetch, now: () => NOW });
    const stream = await app.downloadTarball(5, 'octo/demo', 'b'.repeat(40));
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(gh.calls[1]?.url).toBe(
      `https://api.github.com/repos/octo/demo/tarball/${'b'.repeat(40)}`,
    );
  });

  it('rejects names and SHAs that could inject into the URL path', async () => {
    const gh = fakeGitHub(() => tokenResponse());
    const app = new GitHubApp({ appId: '1', privateKey: pem }, { fetch: gh.fetch, now: () => NOW });
    for (const name of ['octo/demo/../../admin', '../admin', 'octo/..', './x', 'octo/.']) {
      await expect(app.getRepository(1, name)).rejects.toThrow(/Invalid repository/);
    }
    // Dots inside names are legitimate.
    await expect(app.getRepository(1, 'my.org/.github')).resolves.toBeDefined();
    await expect(app.downloadTarball(1, 'octo/demo', '../main')).rejects.toThrow(/Invalid commit/);
  });

  it('marks 404/410/451 as permanent and everything else as retryable', async () => {
    expect(new GitHubApiError(404, 'x').permanent).toBe(true);
    expect(new GitHubApiError(451, 'x').permanent).toBe(true);
    expect(new GitHubApiError(403, 'rate limited').permanent).toBe(false);
    expect(new GitHubApiError(502, 'x').permanent).toBe(false);
  });

  it('supports GitHub Enterprise Server API URLs', async () => {
    const gh = fakeGitHub(() => tokenResponse());
    const app = new GitHubApp(
      { appId: '1', privateKey: pem, apiUrl: 'https://ghe.example.com/api/v3/' },
      { fetch: gh.fetch, now: () => NOW },
    );
    await app.installationToken(3);
    expect(gh.calls[0]?.url).toBe(
      'https://ghe.example.com/api/v3/app/installations/3/access_tokens',
    );
  });
});
