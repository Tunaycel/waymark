/** Test-only indexing thread that never finishes: stands in for a pathological repository. */
import { parentPort } from 'node:worker_threads';

parentPort?.once('message', () => {
  for (;;) {
    // Busy loop: synchronous, so only terminating the thread can stop it.
  }
});
