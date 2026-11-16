import { deleteSession } from '@waymark/db';
import { type NextRequest, NextResponse } from 'next/server';
import { sessionCookieName, webConfig } from '@/lib/config';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Signs out: the session row is deleted, so the token is dead even if a copy of the cookie
 * survives. POST only, and only from our own pages (Origin check), so another site can't sign
 * you out by embedding a link.
 */
export async function POST(request: NextRequest) {
  const config = webConfig();
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== config.publicUrl.origin && origin !== request.nextUrl.origin) {
    return new NextResponse('Forbidden', { status: 403 });
  }
  const name = sessionCookieName(config);
  await deleteSession(db(), request.cookies.get(name)?.value);
  // 303: the browser follows with a GET.
  const response = NextResponse.redirect(new URL('/login', config.publicUrl), 303);
  // A `__Host-` cookie is only replaced by one with the same Secure/Path attributes.
  response.cookies.set(name, '', {
    httpOnly: true,
    secure: config.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
