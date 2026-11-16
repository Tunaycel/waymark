import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// The dashboard reads only what it needs from the repository's .env: the database and the
// sign-in settings. The App's private key, the webhook secret, and AI keys never enter this process.
const WEB_KEYS = [
  'DATABASE_URL',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'WAYMARK_ALLOWED_USERS',
  'WAYMARK_PUBLIC_URL',
  'GITHUB_WEB_URL',
  'GITHUB_API_URL',
];
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) {
  const fromFile = parseEnv(readFileSync(rootEnv, 'utf8'));
  for (const key of WEB_KEYS) {
    // The real environment (e.g. Docker) wins over the file.
    if (process.env[key] === undefined && fromFile[key] !== undefined)
      process.env[key] = fromFile[key];
  }
}

/** @type {import('next').NextConfig} */
const config = {
  // Workspace packages ship TypeScript sources; Next compiles them like app code.
  transpilePackages: ['@waymark/db', '@waymark/github', '@waymark/indexer'],
  serverExternalPackages: ['postgres'],
  // Type checking runs in the monorepo's own `pnpm typecheck` (TypeScript 7).
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
  // The dev badge sits on top of the map's zoom controls.
  devIndicators: false,
  reactStrictMode: true,
};

export default config;
