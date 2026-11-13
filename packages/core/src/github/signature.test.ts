import { describe, expect, it } from 'vitest';
import { signGitHubPayload, verifyGitHubSignature } from './signature.ts';

const secret = 'test-secret-0123456789';
const body = Buffer.from('{"hello":"world"}');

describe('verifyGitHubSignature', () => {
  it('accepts a correct signature', () => {
    expect(verifyGitHubSignature(secret, body, signGitHubPayload(secret, body))).toBe(true);
  });

  it('matches the example from GitHub docs', () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation
    const sig = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    expect(
      verifyGitHubSignature("It's a Secret to Everybody", Buffer.from('Hello, World!'), sig),
    ).toBe(true);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyGitHubSignature(secret, body, signGitHubPayload('other-secret-xyz', body))).toBe(
      false,
    );
  });

  it('rejects a tampered body', () => {
    const sig = signGitHubPayload(secret, body);
    expect(verifyGitHubSignature(secret, Buffer.from('{"hello":"w0rld"}'), sig)).toBe(false);
  });

  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['sha1 header', `sha1=${'a'.repeat(40)}`],
    ['truncated digest', 'sha256=abc123'],
    ['non-hex digest', `sha256=${'z'.repeat(64)}`],
    ['digest too long', `sha256=${'a'.repeat(66)}`],
  ])('rejects %s without throwing', (_label, header) => {
    expect(verifyGitHubSignature(secret, body, header)).toBe(false);
  });

  it('rejects when no secret is configured', () => {
    expect(verifyGitHubSignature('', body, signGitHubPayload('', body))).toBe(false);
  });
});
