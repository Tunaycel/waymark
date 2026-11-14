import { describe, expect, it } from 'vitest';
import { parseInstallationEvent } from './installation.ts';

const repo = (id: number, full_name: string) => ({ id, full_name, name: full_name.split('/')[1] });

describe('parseInstallationEvent', () => {
  it('returns the repositories of a new installation', () => {
    const payload = {
      action: 'created',
      installation: { id: 7 },
      repositories: [repo(1, 'octo/a'), repo(2, 'octo/b')],
    };
    expect(parseInstallationEvent('installation', payload)).toEqual({
      kind: 'repositories',
      installationId: 7,
      repositories: [
        { githubId: 1, fullName: 'octo/a' },
        { githubId: 2, fullName: 'octo/b' },
      ],
    });
  });

  it('returns repositories added to an existing installation', () => {
    const payload = {
      action: 'added',
      installation: { id: 7 },
      repositories_added: [repo(3, 'octo/c')],
      repositories_removed: [],
    };
    expect(parseInstallationEvent('installation_repositories', payload)).toMatchObject({
      repositories: [{ githubId: 3, fullName: 'octo/c' }],
    });
  });

  it('skips other actions and malformed payloads', () => {
    expect(parseInstallationEvent('installation', { action: 'deleted' })).toEqual({
      kind: 'skip',
      reason: 'unhandled_action:deleted',
    });
    expect(parseInstallationEvent('installation', { action: 'created' })).toEqual({
      kind: 'skip',
      reason: 'invalid_payload',
    });
    const injected = {
      action: 'created',
      installation: { id: 1 },
      repositories: [repo(1, '../x')],
    };
    expect(parseInstallationEvent('installation', injected).kind).toBe('skip');
  });
});
