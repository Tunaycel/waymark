/** Test-only child that reports the environment it was given. */
import { serveIsolated } from '../isolated.ts';

serveIsolated(async () => ({ ...process.env }), false);
