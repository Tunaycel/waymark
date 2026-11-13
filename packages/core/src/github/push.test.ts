import { describe, expect, it } from 'vitest';
import { pushPayload } from '../testing/fixtures.ts';
import { parsePushEvent } from './push.ts';

describe('parsePushEvent', () => {
  it('normalizes a branch push into a job', () => {
    const result = parsePushEvent('delivery-1', pushPayload());
    expect(result.kind).toBe('commits');
    if (result.kind !== 'commits') return;

    expect(result.job).toMatchObject({
      deliveryId: 'delivery-1',
      installationId: 987,
      branch: 'main',
      forced: false,
      repository: { githubId: 123456, fullName: 'octo/waymark-demo', isPrivate: true },
    });
    expect(result.job.commits).toHaveLength(1);
    expect(result.job.commits[0]).toMatchObject({
      sha: 'b'.repeat(40),
      authorName: 'Octo Cat',
      authorUsername: 'octocat',
      files: { added: ['src/login.ts'], removed: [], modified: ['README.md'] },
    });
  });

  it('stamps the job with the time Waymark received it', () => {
    const at = new Date('2026-11-13T18:00:00Z');
    const result = parsePushEvent('d', pushPayload(), at);
    expect(result.kind === 'commits' && result.job.receivedAt).toBe('2026-11-13T18:00:00.000Z');
  });

  it('never carries the author email into the job', () => {
    const result = parsePushEvent('d', pushPayload());
    expect(JSON.stringify(result)).not.toContain('octo@example.com');
  });

  it('keeps slashes in branch names', () => {
    const result = parsePushEvent('d', pushPayload({ ref: 'refs/heads/feat/map/v2' }));
    expect(result.kind === 'commits' && result.job.branch).toBe('feat/map/v2');
  });

  it('skips tag pushes', () => {
    expect(parsePushEvent('d', pushPayload({ ref: 'refs/tags/v1.0.0' }))).toEqual({
      kind: 'skip',
      reason: 'not_a_branch',
    });
  });

  it('skips branch deletions', () => {
    expect(parsePushEvent('d', pushPayload({ deleted: true, commits: [] }))).toEqual({
      kind: 'skip',
      reason: 'branch_deleted',
    });
  });

  it('skips pushes without commits (e.g. pushing an existing commit to a new branch)', () => {
    expect(parsePushEvent('d', pushPayload({ commits: [] }))).toEqual({
      kind: 'skip',
      reason: 'no_commits',
    });
  });

  it('works for user-level webhooks without an installation', () => {
    const result = parsePushEvent('d', pushPayload({ installation: undefined }));
    expect(result.kind === 'commits' && result.job.installationId).toBeNull();
  });

  it('accepts commits whose author has no GitHub username', () => {
    const [commit] = pushPayload().commits;
    const payload = pushPayload({
      commits: [{ ...commit, author: { name: 'No Account', email: 'x@y.z' } }],
    });
    const result = parsePushEvent('d', payload);
    expect(result.kind === 'commits' && result.job.commits[0]?.authorUsername).toBeNull();
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['missing repository', { ...pushPayload(), repository: undefined }],
    [
      'a malformed commit sha',
      pushPayload({ commits: [{ ...pushPayload().commits[0], id: 'xyz' }] }),
    ],
  ])('reports %s as invalid with readable issues', (_label, payload) => {
    const result = parsePushEvent('d', payload);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.issues.length).toBeGreaterThan(0);
  });
});
