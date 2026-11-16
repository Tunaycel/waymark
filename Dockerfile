# One image for every Waymark process. Node runs the TypeScript sources directly (no build step),
# except the dashboard, which Next.js builds once here.
#
#   docker compose --profile app up -d --build      (see docker-compose.yml)

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# Dependencies first, so source edits don't re-download them.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/github/package.json packages/github/
COPY packages/indexer/package.json packages/indexer/
COPY packages/mapper/package.json packages/mapper/
COPY packages/queue/package.json packages/queue/
COPY scripts/package.json scripts/
COPY tests/e2e/package.json tests/e2e/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS app
COPY . .
# Files stay owned by root and read-only to the app: a compromised process can't rewrite its own
# code. It runs as the unprivileged `node` user.
USER node
# The service picks its command in docker-compose.yml (server, worker, migrate).
CMD ["node", "apps/server/src/main.ts"]

FROM deps AS web
COPY . .
RUN pnpm --filter @waymark/web build \
  && mkdir -p apps/web/.next/cache && chown -R node:node apps/web/.next/cache
# Only Next's cache directory is writable by the app.
USER node
WORKDIR /app/apps/web
EXPOSE 3100
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3100"]
