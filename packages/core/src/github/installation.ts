import { z } from 'zod';

const repositorySchema = z.object({
  id: z.number().int().positive(),
  // Owner and name: letters, digits, `-`, `_`, `.`; never `.` or `..` (path traversal in API URLs).
  full_name: z.string().regex(/^(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/),
});

const installationSchema = z.object({ id: z.number().int().positive() });

const installationCreated = z.object({
  action: z.literal('created'),
  installation: installationSchema,
  repositories: z.array(repositorySchema).default([]),
});

const repositoriesAdded = z.object({
  action: z.literal('added'),
  installation: installationSchema,
  repositories_added: z.array(repositorySchema).default([]),
});

export interface InstalledRepository {
  githubId: number;
  fullName: string;
}

export type InstallationParseResult =
  | { kind: 'repositories'; installationId: number; repositories: InstalledRepository[] }
  | { kind: 'skip'; reason: string };

/**
 * Repositories that just became visible to the App: on install (`installation.created`) or when
 * the user adds repositories later (`installation_repositories.added`). Each one gets an initial
 * index, so the map exists before the first push. Other actions (deleted, suspend, removed…) are
 * acknowledged and ignored for now.
 */
export function parseInstallationEvent(event: string, payload: unknown): InstallationParseResult {
  const action = (payload as { action?: unknown } | null)?.action;
  if (event === 'installation' && action === 'created') {
    const parsed = installationCreated.safeParse(payload);
    if (!parsed.success) return { kind: 'skip', reason: 'invalid_payload' };
    return {
      kind: 'repositories',
      installationId: parsed.data.installation.id,
      repositories: parsed.data.repositories.map(toRepository),
    };
  }
  if (event === 'installation_repositories' && action === 'added') {
    const parsed = repositoriesAdded.safeParse(payload);
    if (!parsed.success) return { kind: 'skip', reason: 'invalid_payload' };
    return {
      kind: 'repositories',
      installationId: parsed.data.installation.id,
      repositories: parsed.data.repositories_added.map(toRepository),
    };
  }
  return { kind: 'skip', reason: `unhandled_action:${String(action)}` };
}

function toRepository(r: z.infer<typeof repositorySchema>): InstalledRepository {
  return { githubId: r.id, fullName: r.full_name };
}
