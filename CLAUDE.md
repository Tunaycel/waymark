# Waymark — guide for AI agents working in this repo

Waymark is an open-source (AGPL-3.0) personal agent: it watches the user's repositories (and later
calendar, mail and other sources), keeps a living map of each project, reviews daily work, and
sends briefs. Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md).

## Non-negotiable workflow (set by the maintainer)

1. **Never push, open a repo, or publish anything without the maintainer's explicit approval** in
   the current conversation. An earlier approval does not cover a later push.
2. **Every change goes on its own branch** (`feat/…`, `fix/…`, `chore/…`, `docs/…`) and reaches
   `main` only through a pull request. CI must be green. **Only the maintainer merges.**
3. **Before presenting any work:** run a code review (sub-agents are allowed), then deliberately
   try to break it — ask "what input, timing, failure or scale makes this wrong?" — fix what you
   find, and only then present. Do not hand over work just to collect an approval.
4. **Explain the reasoning.** When reporting progress, say what was built *and why it is built
   that way*, in plain language (the maintainer prefers Turkish in conversation; code, commits,
   and docs are in English).
5. **Commits are authored only by the maintainer's configured git identity.** Do not add
   `Co-Authored-By` or any other attribution trailer, and no AI attribution in PR descriptions.
   Commits use the GitHub noreply address.
6. Discuss with the maintainer before starting the next roadmap phase.

## Commands

```bash
pnpm install
pnpm infra:up            # Postgres (5433) + Redis (6380) via docker compose
pnpm db:migrate          # apply migrations (reads DATABASE_URL from .env)
pnpm dev                 # server + worker with --watch
pnpm lint                # Biome (lint + format check); pnpm lint:fix to apply
pnpm typecheck           # tsc in every package
pnpm test                # unit tests (no infrastructure needed)
pnpm test:integration    # real Postgres + Redis; requires infra:up
pnpm db:generate         # after editing packages/db/src/schema.ts — commit the generated SQL
pnpm map:local <path>    # index a local checkout and print modules, edges, dependencies
pnpm bench               # webhook load test (needs a running server + worker)
pnpm bench:index o/r …   # index public GitHub repositories and report timings
```

## Conventions

- **TypeScript runs natively on Node ≥ 22.18** (type stripping). There is no build step: packages
  export `src/*.ts` directly. Consequences: use only erasable syntax (no `enum`, no parameter
  properties, no `namespace`), and write relative imports **with** the `.ts` extension.
- Validate every external input (env, webhooks, APIs) with zod at the boundary; inside the system
  pass normalized types (`PushJob`, …), never raw payloads.
- Ingestion must stay **idempotent**: GitHub redelivers webhooks, and jobs retry.
- Do not store data the product doesn't need (e.g. commit author emails are dropped at parse time).
- Schema changes: edit `schema.ts`, run `pnpm db:generate`, commit the migration. CI fails if they
  drift.
- Tests: unit tests next to the code (`*.test.ts`); anything needing Postgres/Redis goes in
  `tests/e2e`.
- The indexer must never execute or trust repository content: no `require` of user code, no
  following symlinks, paths normalised and length-limited, size limits on files and archives.
