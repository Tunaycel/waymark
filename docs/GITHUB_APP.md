# Connecting GitHub

Waymark receives repository events through a **GitHub App** you own. Nothing is polled, and the App
only sees the repositories you install it on.

## 1. Create the App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**

| Field | Value |
|---|---|
| Homepage URL | anything (e.g. your fork's URL) |
| Webhook URL | `https://<public-url>/webhooks/github` (see step 3 for local development) |
| Callback URL | `http://127.0.0.1:3100/auth/callback` (dashboard sign-in; use your `WAYMARK_PUBLIC_URL` when hosted) |
| Request user authorization (OAuth) during installation | off |
| Webhook secret | output of `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| Repository permissions | **Contents: Read-only**, **Metadata: Read-only** |
| Subscribe to events | **Push** |
| Where can this App be installed? | Only on this account |

Put the same secret in `.env` as `GITHUB_WEBHOOK_SECRET`.

`installation` and `installation_repositories` events are delivered to every App without
subscribing; Waymark uses them to index repositories as soon as they are added, and to hide them
from the dashboard as soon as they are removed (their history is kept).

### Credentials for indexing

The worker downloads repository snapshots as the App. On the App page:

1. Copy the **App ID** into `.env` as `GITHUB_APP_ID`.
2. **Private keys → Generate a private key.** Put the PEM into `.env` as `GITHUB_APP_PRIVATE_KEY`,
   either on one line with `
` for the line breaks or as a quoted multi-line value.

Without these two variables the worker still ingests pushes but skips indexing (it logs a warning
at startup). For GitHub Enterprise Server, also set `GITHUB_API_URL=https://HOST/api/v3`.

### Dashboard sign-in

The dashboard signs people in with the same App (GitHub's OAuth for Apps; no separate OAuth App):

1. Copy the App's **Client ID** into `.env` as `GITHUB_APP_CLIENT_ID`.
2. **Generate a new client secret**; put it in `.env` as `GITHUB_APP_CLIENT_SECRET`.
3. List who may sign in: `WAYMARK_ALLOWED_USERS=your-github-login` (comma separated).

Each person sees only the repositories they can open on GitHub that the App is installed on,
refreshed every time they sign in. Their GitHub token is used once, at sign-in, never stored, and
revoked right after; sessions last 24 hours and are stored as hashes. Removing someone from
`WAYMARK_ALLOWED_USERS` signs them out at the next request after a restart. Without the two
client variables the dashboard runs on localhost only, without sign-in, as before.

> [!WARNING]
> Never put the dashboard behind a reverse proxy or tunnel without sign-in. It refuses requests
> that show proxy traces (`Forwarded`, `X-Real-IP`, a multi-hop `X-Forwarded-For`), but a proxy
> that adds none of them looks exactly like this machine. To reach it from elsewhere, configure
> sign-in and `WAYMARK_PUBLIC_URL` first.

## 2. Install it

App page → **Install App** → choose *All repositories* or pick the ones Waymark should follow.

## 3. Receive webhooks on your machine

GitHub must reach your server. During development, forward deliveries with a tunnel, for example:

```bash
npx smee-client --url https://smee.io/<your-channel> --target http://localhost:3000/webhooks/github
```

Use the smee channel URL as the App's webhook URL. smee re-sends the original body and headers, so
the signature check still applies.

## 4. Verify

1. `pnpm infra:up && pnpm db:migrate && pnpm dev`
2. On the App's **Advanced** tab, GitHub shows a `ping` delivery. Redeliver it; the response should
   be `200 {"status":"pong"}`.
3. Push a commit to an installed repository. The worker logs `push ingested` with the number of
   commits inserted.
4. About 15 seconds after the last push to the default branch, the worker logs `repository indexed`
   with the number of files, edges, and modules. Installing the App on a new repository triggers
   the same right away.
