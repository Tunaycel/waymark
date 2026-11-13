/** Builds a realistic GitHub `push` payload. Shared by unit and integration tests. */
export function pushPayload(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'refs/heads/main',
    before: 'a'.repeat(40),
    after: 'b'.repeat(40),
    deleted: false,
    forced: false,
    repository: {
      id: 123456,
      full_name: 'octo/waymark-demo',
      private: true,
      default_branch: 'main',
    },
    installation: { id: 987 },
    commits: [
      {
        id: 'b'.repeat(40),
        message: 'feat: add login form',
        timestamp: '2026-11-13T09:30:00+03:00',
        url: `https://github.com/octo/waymark-demo/commit/${'b'.repeat(40)}`,
        distinct: true,
        author: { name: 'Octo Cat', email: 'octo@example.com', username: 'octocat' },
        added: ['src/login.ts'],
        removed: [],
        modified: ['README.md'],
      },
    ],
    ...overrides,
  };
}
