import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

export function createDatabase(url: string, options: { max?: number } = {}): DatabaseHandle {
  const sql = postgres(url, {
    max: options.max ?? 10,
    // Keep Postgres NOTICE messages (e.g. "relation already exists, skipping") out of the logs.
    onnotice: () => {},
  });
  return {
    db: drizzle(sql, { schema }),
    close: () => sql.end({ timeout: 5 }),
  };
}
