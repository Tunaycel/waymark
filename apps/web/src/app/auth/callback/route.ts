import { timingSafeEqual } from 'node:crypto';
import { createSession, findUserByLogin, upsertUser } from '@waymark/db';
import {
  exchangeCode,
  fetchUser,
  fetchUserRepositoryIds,
  OAuthError,
  revokeToken,
} from '@waymark/github/oauth';
import { type NextRequest, NextResponse } from 'next/server';
import { STATE_COOKIE, sessionCookieName, webConfig } from '@/lib/config';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function sameState(a: string | undefined, b: string | null): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * GitHub sends the browser back here. The state must match the cookie set when sign-in started
 * (no one else can start a sign-in for you), the user must be on the allowlist, and only then is a
 * session created. Every failure lands on the sign-in page with a reason code, never a stack.
 */
export async function GET(request: NextRequest) {
  const config = webConfig();
  const fail = (reason: string) => {
    const url = new URL('/login', config.publicUrl);
    url.searchParams.set('error', reason);
    const response = NextResponse.redirect(url);
    response.cookies.delete({ name: STATE_COOKIE, path: '/auth' });
    return response;
  };
  if (!config.auth) return NextResponse.redirect(new URL('/', config.publicUrl));

  const params = request.nextUrl.searchParams;
  // The state is checked first, even for "cancelled": another site can't end a sign-in in progress.
  if (!sameState(request.cookies.get(STATE_COOKIE)?.value, params.get('state'))) {
    return fail('state');
  }
  if (params.get('error') === 'access_denied') return fail('cancelled');
  const code = params.get('code');
  if (!code || code.length > 256) return fail('code');

  const oauth = config.auth;
  let token: string | null = null;
  try {
    const callback = new URL('/auth/callback', config.publicUrl).toString();
    token = await exchangeCode(oauth, code, callback);
    const user = await fetchUser(oauth, token);
    if (!oauth.allowed.has(user.login.toLowerCase())) {
      console.warn('sign-in refused: login not in WAYMARK_ALLOWED_USERS');
      return fail('not_allowed');
    }
    // A login belongs to the GitHub account that first signed in with it. If that account was
    // renamed and someone else took the name, the newcomer is not let in under the old allowance.
    const known = await findUserByLogin(db(), user.login);
    if (known && known.githubId !== user.id) {
      console.warn('sign-in refused: login now belongs to a different GitHub account');
      return fail('not_allowed');
    }
    const repositoryIds = await fetchUserRepositoryIds(oauth, token);
    const userId = await upsertUser(db(), {
      githubId: user.id,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatarUrl,
      repositoryIds,
    });
    const session = await createSession(db(), userId);

    const response = NextResponse.redirect(new URL('/', config.publicUrl));
    response.cookies.delete({ name: STATE_COOKIE, path: '/auth' });
    response.cookies.set(sessionCookieName(config), session.token, {
      httpOnly: true,
      secure: config.secure,
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
    });
    return response;
  } catch (error) {
    const reason = error instanceof OAuthError ? error.reason : 'failed';
    console.error(`sign-in failed: ${reason}`);
    return fail(error instanceof OAuthError ? 'github' : 'failed');
  } finally {
    // Never stored, and not left usable either.
    if (token) await revokeToken(oauth, token);
  }
}
