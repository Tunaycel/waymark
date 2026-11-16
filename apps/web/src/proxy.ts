import { type NextRequest, NextResponse } from 'next/server';
import {
  hostName,
  isAllowedHost,
  isForwardedWithoutSignIn,
  sessionCookieName,
  webConfig,
} from './lib/config';

// Kept as a named export for tests and callers that only need the host rule.
export { isLoopbackHost } from './lib/config';

/** Reachable without a session: the sign-in flow, and sign-out (it checks Origin itself). */
const PUBLIC_PATHS = ['/login', '/auth/github', '/auth/callback', '/auth/logout'];

const text = (status: number, body: string) =>
  new NextResponse(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

/**
 * First gate for every request:
 *
 * 1. A configuration error closes the dashboard (it never falls back to "open"). The reason is in
 *    the server log, not shown to visitors.
 * 2. Only loopback names, and the public URL's host once sign-in is on, are answered. Binding to
 *    loopback does not stop DNS rebinding: a page on evil.example can point its own name at
 *    127.0.0.1 and read this server same-origin, but it can't change the `Host` it sends.
 * 3. Without sign-in, a request that came through a reverse proxy is refused: the dashboard is for
 *    this machine only, and a proxy would make it public.
 * 4. With sign-in on, a request without a session cookie goes to the sign-in page. The cookie is
 *    validated against the database by the page or API route itself (`requireScope`/`apiScope`).
 */
export function proxy(request: NextRequest) {
  const config = webConfig();
  if (config.error) return text(503, 'Waymark is not configured correctly. See the server log.');
  const host = request.headers.get('host');
  if (!isAllowedHost(config, host)) {
    return text(403, 'Forbidden: this Waymark dashboard does not answer on this address.');
  }
  if (isForwardedWithoutSignIn(config, request.headers)) {
    return text(403, 'Forbidden: without GitHub sign-in this dashboard is for this machine only.');
  }
  if (!config.auth) return NextResponse.next();

  const path = request.nextUrl.pathname;
  // Sign-in must start where it ends: the state cookie is set on the host GitHub returns to.
  if (path === '/auth/github' && hostName(host) !== hostName(config.publicUrl.host)) {
    return NextResponse.redirect(new URL('/auth/github', config.publicUrl));
  }
  if (PUBLIC_PATHS.includes(path)) return NextResponse.next();
  if (request.cookies.has(sessionCookieName(config))) return NextResponse.next();
  if (path.startsWith('/api/')) return text(401, 'Sign in first.');
  // 303: whatever the method, the browser follows with a GET.
  return NextResponse.redirect(new URL('/login', config.publicUrl), 303);
}

export const config = {
  // Everything except Next's own static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
