import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth';
import { webConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  not_allowed:
    'This GitHub account is not on the list of people allowed to use this Waymark. Ask its owner to add you to WAYMARK_ALLOWED_USERS.',
  cancelled: 'Sign-in was cancelled on GitHub.',
  state: 'That sign-in link expired or was opened in another browser. Please try again.',
  code: 'GitHub sent back an incomplete answer. Please try again.',
  github:
    'GitHub refused the sign-in. Please try again; if it keeps failing, check the App’s client secret and callback URL.',
  failed: 'Something went wrong while signing in. Please try again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const config = webConfig();
  // Without sign-in configured there is nothing to sign in to (localhost only).
  if (!config.auth) redirect('/');
  if (await getViewer()) redirect('/');
  const { error } = await searchParams;
  const message = typeof error === 'string' ? (MESSAGES[error] ?? MESSAGES.failed) : null;
  const nobodyAllowed = config.auth.allowed.size === 0;

  return (
    <main className="grid min-h-[calc(100dvh-3.5rem)] place-items-center px-5">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-panel/70 p-7 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-text">Sign in to Waymark</h1>
        <p className="mt-2 text-sm text-muted">
          Your projects, as a living map. Only the repositories you installed the Waymark GitHub App
          on are shown.
        </p>
        {message && (
          <p
            role="alert"
            className="mt-5 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-left text-sm text-text"
          >
            {message}
          </p>
        )}
        {nobodyAllowed && (
          <p className="mt-5 rounded-lg border border-todo/40 bg-todo/10 px-3 py-2 text-left text-sm text-text">
            Nobody can sign in yet: WAYMARK_ALLOWED_USERS is empty.
          </p>
        )}
        {/* A plain link: the sign-in starts with a top-level navigation, as OAuth expects. */}
        <a
          href="/auth/github"
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-text px-4 py-2.5 text-sm font-medium text-bg transition hover:bg-text/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <GitHubMark />
          Sign in with GitHub
        </a>
      </div>
    </main>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
