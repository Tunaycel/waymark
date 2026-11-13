import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Verifies GitHub's `X-Hub-Signature-256` header against the raw request body.
 *
 * Must run on the exact bytes GitHub sent — re-serialising parsed JSON changes whitespace and
 * breaks the HMAC. Comparison is constant-time to avoid leaking the signature via timing.
 */
export function verifyGitHubSignature(
  secret: string,
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
): boolean {
  if (!secret || !signatureHeader?.startsWith(PREFIX)) return false;

  const provided = signatureHeader.slice(PREFIX.length);
  if (!HEX_SHA256.test(provided)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(provided, 'hex'));
}

/** Produces a signature header. Used by tests and local tooling to simulate GitHub deliveries. */
export function signGitHubPayload(secret: string, rawBody: Uint8Array | string): string {
  return PREFIX + createHmac('sha256', secret).update(rawBody).digest('hex');
}
