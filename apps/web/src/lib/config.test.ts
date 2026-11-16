import { describe, expect, it } from 'vitest';
import {
  isAllowedHost,
  isForwardedWithoutSignIn,
  readWebConfig,
  sessionCookieName,
} from './config';

const signIn = { GITHUB_APP_CLIENT_ID: 'Iv1.x', GITHUB_APP_CLIENT_SECRET: 's' };

describe('readWebConfig', () => {
  it('runs locally without sign-in by default', () => {
    const c = readWebConfig({});
    expect(c.error).toBeNull();
    expect(c.auth).toBeNull();
    expect(c.publicUrl.origin).toBe('http://127.0.0.1:3100');
    expect(c.secure).toBe(false);
  });

  it('enables sign-in with both credentials and reads the allowlist', () => {
    const c = readWebConfig({ ...signIn, WAYMARK_ALLOWED_USERS: 'Tunaycel, octo' });
    expect(c.error).toBeNull();
    expect([...(c.auth?.allowed ?? [])]).toEqual(['tunaycel', 'octo']);
  });

  it.each([
    [{ GITHUB_APP_CLIENT_ID: 'only-id' }, 'both'],
    [{ WAYMARK_PUBLIC_URL: 'https://waymark.example' }, 'needs GitHub sign-in'],
    [{ ...signIn, WAYMARK_PUBLIC_URL: 'http://waymark.example' }, 'https'],
    [{ ...signIn, WAYMARK_PUBLIC_URL: 'https://waymark.example/app' }, 'origin'],
    [{ WAYMARK_PUBLIC_URL: 'not a url' }, 'valid URL'],
    [{ WAYMARK_PUBLIC_URL: 'ftp://127.0.0.1' }, 'http(s)'],
  ])('refuses to start half-configured: %j', (env, message) => {
    const c = readWebConfig(env);
    expect(c.error).toContain(message);
    expect(c.auth).toBeNull();
  });

  it('allows a public https URL with sign-in, with secure cookies', () => {
    const c = readWebConfig({ ...signIn, WAYMARK_PUBLIC_URL: 'https://waymark.example' });
    expect(c.error).toBeNull();
    expect(c.secure).toBe(true);
    expect(sessionCookieName(c)).toBe('__Host-waymark_session');
  });
});

describe('isAllowedHost', () => {
  const local = readWebConfig({});
  const hosted = readWebConfig({ ...signIn, WAYMARK_PUBLIC_URL: 'https://waymark.example' });

  it('always answers on loopback names', () => {
    for (const host of ['127.0.0.1:3100', 'localhost', '[::1]:3100']) {
      expect(isAllowedHost(local, host)).toBe(true);
      expect(isAllowedHost(hosted, host)).toBe(true);
    }
  });

  it('answers on the public host only when signed-in mode is on', () => {
    expect(isAllowedHost(hosted, 'waymark.example')).toBe(true);
    expect(isAllowedHost(hosted, 'WAYMARK.example:443')).toBe(true);
    expect(isAllowedHost(local, 'waymark.example')).toBe(false);
  });

  it('refuses look-alikes and other hosts (DNS rebinding)', () => {
    for (const host of [
      null,
      '',
      'evil.example',
      'waymark.example.evil.example',
      '127.0.0.1.evil.example',
    ]) {
      expect(isAllowedHost(hosted, host)).toBe(false);
    }
  });
});

describe('hardening', () => {
  it.each([
    [
      { ...signIn, WAYMARK_PUBLIC_URL: 'https://user:pass@waymark.example' },
      'user name or password',
    ],
    [{ ...signIn, WAYMARK_PUBLIC_URL: 'https://waymark.example.' }, 'dot'],
  ])('refuses %j', (env, message) => {
    expect(readWebConfig(env).error).toContain(message);
  });

  it('parses Host strictly: junk after a loopback name is not loopback', () => {
    const local = readWebConfig({});
    for (const host of [
      '[::1]evil',
      '127.0.0.1:3100, evil.example',
      'localhost:evil',
      'localhost x',
    ]) {
      expect(isAllowedHost(local, host)).toBe(false);
    }
  });

  it('refuses forwarded requests without sign-in, allows them with it', () => {
    const local = readWebConfig({});
    const hosted = readWebConfig({ ...signIn, WAYMARK_PUBLIC_URL: 'https://waymark.example' });
    for (const traces of [
      { forwarded: 'for=203.0.113.9' },
      { 'x-real-ip': '203.0.113.9' },
      { 'x-forwarded-for': '203.0.113.9, 172.18.0.1' },
    ]) {
      expect(isForwardedWithoutSignIn(local, new Headers(traces))).toBe(true);
      expect(isForwardedWithoutSignIn(hosted, new Headers(traces))).toBe(false);
    }
    // What Next.js adds to every direct request by itself is not a proxy trace.
    const direct = new Headers({
      'x-forwarded-for': '172.23.0.1',
      'x-forwarded-host': '127.0.0.1:3100',
      'x-forwarded-proto': 'http',
    });
    expect(isForwardedWithoutSignIn(local, direct)).toBe(false);
  });

  it('shows demo repositories to signed-in users only when opted in', () => {
    expect(readWebConfig(signIn).auth?.showDemos).toBe(false);
    expect(readWebConfig({ ...signIn, WAYMARK_SHOW_DEMOS: 'true' }).auth?.showDemos).toBe(true);
  });

  it('reports allowlist entries it had to ignore', () => {
    const c = readWebConfig({ ...signIn, WAYMARK_ALLOWED_USERS: 'tunaycel, "carol", @@bob' });
    expect([...(c.auth?.allowed ?? [])]).toEqual(['tunaycel']);
    expect(c.ignoredAllowlistEntries).toEqual(['"carol"', '@@bob']);
  });
});
