import 'server-only';
import { createDatabase, type DatabaseHandle } from '@waymark/db';

/**
 * One small connection pool per server process. Development hot reloads re-evaluate modules, so
 * the handle is kept on `globalThis` instead of being recreated (and leaking pools) on every edit.
 */
const globalForDb = globalThis as unknown as { waymarkDb?: DatabaseHandle };

export function db() {
  if (!globalForDb.waymarkDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set (see .env.example)');
    globalForDb.waymarkDb = createDatabase(url, { max: 5 });
  }
  return globalForDb.waymarkDb.db;
}
