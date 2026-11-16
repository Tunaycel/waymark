import { parseAllowlist } from '@waymark/github/oauth';

/**
 * How the dashboard is exposed, from the environment. Two modes:
 *
 * - **Local** (no GitHub sign-in configured): answers only on localhost, shows every repository.
 * - **Signed in** (`GITHUB_APP_CLIENT_ID` + `GITHUB_APP_CLIENT_SECRET`): only allowlisted GitHub
 *   users get in, each sees the repositories they can access through the App, and the dashboard
 *   may also answer on `WAYMARK_PUBLIC_URL`.
 *
 * Anything half-configured is an error that keeps the dashboard closed, never a silent fallback
 * to "open": e.g. a public URL without sign-in.
 */

export interface AuthSettings {
  clientId: string;
  clientSecret: string;
  allowed: Set<string>;
  webUrl: string;
  apiUrl: string;
  /** Local demo repositories (`pnpm demo`) are shown to signed-in users only when opted in. */
  showDemos: boolean;
}

export interface WebConfig {
  /** Where the dashboard is reached; sign-in redirects come back here. */
  publicUrl: URL;
  /** Secure cookies and `__Host-` names over HTTPS. */
  secure: boolean;
  auth: AuthSettings | null;
  /** A configuration problem: the dashboard refuses every request (and logs why, once). */
  error: string | null;
  /** Allowlist entries that are not GitHub logins, ignored; reported once at startup. */
  ignoredAllowlistEntries: string[];
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** `name[:port]` or `[ipv6][:port]`, nothing else (no commas, spaces, or trailing junk). */
const HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i;

export function hostName(host: string | null | undefined): string | null {
  if (!host || !HOST.test(host)) return null;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return (name ?? '').toLowerCase() || null;
}

export function isLoopbackHost(host: string | null | undefined): boolean {
  const name = hostName(host);
  return name !== null && LOOPBACK.has(name);
}

const DEFAULT_PUBLIC_URL = 'http://127.0.0.1:3100';

export function readWebConfig(env: Record<string, string | undefined>): WebConfig {
  const fail = (error: string): WebConfig => ({
    publicUrl: new URL(DEFAULT_PUBLIC_URL),
    secure: false,
    auth: null,
    error,
    ignoredAllowlistEntries: [],
  });

  let publicUrl: URL;
  try {
    publicUrl = new URL(env.WAYMARK_PUBLIC_URL?.trim() || DEFAULT_PUBLIC_URL);
  } catch {
    return fail('WAYMARK_PUBLIC_URL is not a valid URL');
  }
  if (publicUrl.protocol !== 'https:' && publicUrl.protocol !== 'http:') {
    return fail('WAYMARK_PUBLIC_URL must be http(s)');
  }
  if (publicUrl.username || publicUrl.password) {
    return fail('WAYMARK_PUBLIC_URL must not contain a user name or password');
  }
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    return fail(
      'WAYMARK_PUBLIC_URL must be an origin, without a path (e.g. https://waymark.example)',
    );
  }
  if (publicUrl.hostname.endsWith('.')) {
    return fail('WAYMARK_PUBLIC_URL must not end with a dot');
  }
  const local = isLoopbackHost(publicUrl.host);
  if (!local && publicUrl.protocol !== 'https:') {
    return fail('WAYMARK_PUBLIC_URL must use https when it is not localhost');
  }

  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    return fail('set both GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET, or neither');
  }
  if (!local && !clientId) {
    return fail('a public WAYMARK_PUBLIC_URL needs GitHub sign-in (GITHUB_APP_CLIENT_ID/SECRET)');
  }

  const raw = (env.WAYMARK_ALLOWED_USERS ?? '').split(/[\s,]+/).filter(Boolean);
  const allowed = parseAllowlist(env.WAYMARK_ALLOWED_USERS);
  const ignoredAllowlistEntries = raw.filter(
    (entry) => !allowed.has(entry.replace(/^@/, '').toLowerCase()),
  );
  const auth =
    clientId && clientSecret
      ? {
          clientId,
          clientSecret,
          allowed,
          webUrl: env.GITHUB_WEB_URL?.trim() || 'https://github.com',
          apiUrl: env.GITHUB_API_URL?.trim() || 'https://api.github.com',
          showDemos: /^(1|true|yes)$/i.test(env.WAYMARK_SHOW_DEMOS?.trim() ?? ''),
        }
      : null;
  return {
    publicUrl,
    secure: publicUrl.protocol === 'https:',
    auth,
    error: null,
    ignoredAllowlistEntries,
  };
}

/** Hosts the dashboard answers on: always localhost; the public URL's host once sign-in is on. */
export function isAllowedHost(config: WebConfig, host: string | null): boolean {
  if (isLoopbackHost(host)) return true;
  return config.auth !== null && hostName(host) === hostName(config.publicUrl.host);
}

/**
 * Without sign-in the dashboard is for this machine only. A reverse proxy in front of it (nginx
 * passing `Host: 127.0.0.1`) would make it public, so requests showing proxy traces are refused.
 * With sign-in on, a proxy is fine: every request needs a session.
 *
 * Only traces Next.js never adds itself count: Next fills in `x-forwarded-for/-host/-proto` from
 * the connection on every request, so their mere presence proves nothing. `Forwarded`,
 * `X-Real-IP`, or an `X-Forwarded-For` with more than one hop do. A proxy that adds none of these
 * cannot be detected: local mode must never be put behind one (docs/GITHUB_APP.md).
 */
export function isForwardedWithoutSignIn(config: WebConfig, headers: Headers): boolean {
  if (config.auth !== null) return false;
  return (
    headers.has('forwarded') ||
    headers.has('x-real-ip') ||
    (headers.get('x-forwarded-for') ?? '').includes(',')
  );
}

/** `__Host-` binds the cookie to this exact origin over HTTPS (no Domain, Path=/, Secure). */
export function sessionCookieName(config: WebConfig): string {
  return config.secure ? '__Host-waymark_session' : 'waymark_session';
}

export const STATE_COOKIE = 'waymark_oauth_state';

let cached: WebConfig | null = null;

/** The process's configuration, read once; problems are logged once, not on every request. */
export function webConfig(): WebConfig {
  if (!cached) {
    cached = readWebConfig(process.env);
    if (cached.error) console.error(`dashboard disabled: ${cached.error}`);
    if (cached.ignoredAllowlistEntries.length > 0) {
      console.warn(
        `WAYMARK_ALLOWED_USERS: ignored ${cached.ignoredAllowlistEntries.length} entr${cached.ignoredAllowlistEntries.length === 1 ? 'y' : 'ies'} that are not GitHub logins`,
      );
    }
  }
  return cached;
}
