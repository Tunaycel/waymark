# Connecting GitHub

Waymark receives repository events through a **GitHub App** you own. Nothing is polled, and the App
only sees the repositories you install it on.

## 1. Create the App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**

| Field | Value |
|---|---|
| Homepage URL | anything (e.g. your fork's URL) |
| Webhook URL | `https://<public-url>/webhooks/github` (see step 3 for local development) |
| Webhook secret | output of `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| Repository permissions | **Contents: Read-only**, **Metadata: Read-only** |
| Subscribe to events | **Push** |
| Where can this App be installed? | Only on this account |

Put the same secret in `.env` as `GITHUB_WEBHOOK_SECRET`.

`installation` and `installation_repositories` events are delivered to every App without
subscribing; Waymark uses them to index repositories as soon as they are added.

### Credentials for indexing

The worker downloads repository snapshots as the App. On the App page:

1. Copy the **App ID** into `.env` as `GITHUB_APP_ID`.
2. **Private keys → Generate a private key.** Put the PEM into `.env` as `GITHUB_APP_PRIVATE_KEY`,
   either on one line with `
` for the line breaks or as a quoted multi-line value.

Without these two variables the worker still ingests pushes but skips indexing (it logs a warning
at startup). For GitHub Enterprise Server, also set `GITHUB_API_URL=https://HOST/api/v3`.

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
