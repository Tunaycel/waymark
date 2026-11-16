import 'server-only';
import {
  ALL_REPOSITORIES,
  deleteUserSessions,
  findViewer,
  NO_REPOSITORIES,
  type RepositoryScope,
  scopeOf,
  type Viewer,
} from '@waymark/db';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { sessionCookieName, webConfig } from './config';
import { db } from './db';

/**
 * The signed-in user for this request (one lookup per request), or null. The allowlist is checked
 * on every request, not only at sign-in: taking someone off \`WAYMARK_ALLOWED_USERS\` (and restarting
 * the dashboard) signs them out everywhere at once.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const config = webConfig();
  if (config.error || !config.auth) return null;
  const token = (await cookies()).get(sessionCookieName(config))?.value;
  const viewer = await findViewer(db(), token);
  if (!viewer) return null;
  if (!config.auth.allowed.has(viewer.login.toLowerCase())) {
    await deleteUserSessions(db(), viewer.userId);
    return null;
  }
  return viewer;
});

/**
 * What this page may show. Local mode (no sign-in, localhost only): everything. Signed-in mode:
 * the viewer's repositories; an anonymous visitor is sent to sign in. A configuration error shows
 * nothing at all; the proxy already answers 503, this is the second lock on the same door.
 */
export async function requireScope(): Promise<RepositoryScope> {
  const config = webConfig();
  if (config.error) return NO_REPOSITORIES;
  if (!config.auth) return ALL_REPOSITORIES;
  const viewer = await getViewer();
  if (!viewer) redirect('/login');
  return scopeOf(viewer, { demos: config.auth.showDemos });
}

/** Same for API routes: null means "answer 401", never a redirect. */
export async function apiScope(): Promise<RepositoryScope | null> {
  const config = webConfig();
  if (config.error) return null;
  if (!config.auth) return ALL_REPOSITORIES;
  const viewer = await getViewer();
  return viewer ? scopeOf(viewer, { demos: config.auth.showDemos }) : null;
}
