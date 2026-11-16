import { randomBytes } from 'node:crypto';
import { authorizeUrl } from '@waymark/github/oauth';
import { NextResponse } from 'next/server';
import { STATE_COOKIE, webConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

/** Starts "Sign in with GitHub": a random state in a short-lived cookie, then off to GitHub. */
export function GET() {
  const config = webConfig();
  if (!config.auth) return NextResponse.redirect(new URL('/', config.publicUrl));
  const state = randomBytes(24).toString('base64url');
  const callback = new URL('/auth/callback', config.publicUrl).toString();
  const response = NextResponse.redirect(authorizeUrl(config.auth, callback, state));
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: config.secure,
    // Lax: the cookie comes back on GitHub's top-level redirect to the callback.
    sameSite: 'lax',
    path: '/auth',
    maxAge: 600,
  });
  return response;
}
