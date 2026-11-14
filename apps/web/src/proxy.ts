import { type NextRequest, NextResponse } from 'next/server';

/**
 * The dashboard has no sign-in yet and listens on 127.0.0.1 only. Binding to loopback does not
 * stop DNS rebinding: a page on evil.example can re-point its own name at 127.0.0.1 and read this
 * server same-origin. Such requests carry the attacker's name in `Host`, so anything that is not a
 * loopback name is refused before a page or API route runs.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  // `host` is `name[:port]`; an IPv6 literal keeps its brackets.
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOOPBACK.has((name ?? '').toLowerCase());
}

export function proxy(request: NextRequest) {
  if (!isLoopbackHost(request.headers.get('host'))) {
    return new NextResponse('Forbidden: the Waymark dashboard only answers on localhost.', {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return NextResponse.next();
}
