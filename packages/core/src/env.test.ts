import { describe, expect, it } from 'vitest';
import { EnvError, loadBaseEnv, loadServerEnv } from './env.ts';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5433/waymark',
  REDIS_URL: 'redis://localhost:6380',
  GITHUB_WEBHOOK_SECRET: 'x'.repeat(32),
};

describe('env', () => {
  it('applies defaults', () => {
    const env = loadServerEnv(valid);
    expect(env).toMatchObject({ PORT: 3000, HOST: '0.0.0.0', LOG_LEVEL: 'info' });
  });

  it('coerces PORT from a string', () => {
    expect(loadServerEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('treats empty values as unset', () => {
    expect(loadServerEnv({ ...valid, PORT: '' }).PORT).toBe(3000);
  });

  it('reports every problem at once', () => {
    try {
      loadServerEnv({ DATABASE_URL: 'mysql://nope', GITHUB_WEBHOOK_SECRET: 'short' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      const issues = (err as EnvError).issues.join('\n');
      expect(issues).toContain('DATABASE_URL');
      expect(issues).toContain('REDIS_URL');
      expect(issues).toContain('GITHUB_WEBHOOK_SECRET');
    }
  });

  it('does not require the webhook secret for non-server processes', () => {
    const { GITHUB_WEBHOOK_SECRET: _omit, ...rest } = valid;
    expect(() => loadBaseEnv(rest)).not.toThrow();
  });
});
