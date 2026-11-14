import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// The dashboard reads the repository's .env for DATABASE_URL only: it needs no API keys or the
// GitHub App key, so they never enter this process.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (!process.env.DATABASE_URL && existsSync(rootEnv)) {
  const { DATABASE_URL } = parseEnv(readFileSync(rootEnv, 'utf8'));
  if (DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;
}

/** @type {import('next').NextConfig} */
const config = {
  // Workspace packages ship TypeScript sources; Next compiles them like app code.
  transpilePackages: ['@waymark/db', '@waymark/indexer'],
  serverExternalPackages: ['postgres'],
  // Type checking runs in the monorepo's own `pnpm typecheck` (TypeScript 7).
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
  // The dev badge sits on top of the map's zoom controls.
  devIndicators: false,
  reactStrictMode: true,
};

export default config;
