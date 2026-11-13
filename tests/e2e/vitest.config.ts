import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests share one Postgres database and truncate it; run files one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
