/** Test-only indexing thread that allocates until it exceeds its heap budget. */
import { parentPort } from 'node:worker_threads';

parentPort?.once('message', () => {
  const hoard: string[][] = [];
  for (;;) hoard.push(Array.from({ length: 100_000 }, (_, i) => `entry-${i}-${hoard.length}`));
});
