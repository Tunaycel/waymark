import { describe, expect, it } from 'vitest';
import { isLoopbackHost } from '../proxy';
import { mapHref, nameFromSegments } from './paths';

describe('map paths', () => {
  it('round-trips names with URL-special characters', () => {
    for (const name of [
      'acme/app',
      'local/c#-tools',
      'local/what?',
      'local/100%done',
      'local/ünï cödé',
    ]) {
      const href = mapHref(name);
      expect(href.startsWith('/r/')).toBe(true);
      expect(href).not.toMatch(/[#?]/);
      expect(nameFromSegments(href.slice(3).split('/'))).toBe(name);
    }
  });

  it('rejects control characters', () => {
    expect(nameFromSegments(['local', '%00'])).toBeNull();
    expect(nameFromSegments(['a', 'b%0A'])).toBeNull();
  });

  it('keeps a malformed escape instead of throwing', () => {
    expect(nameFromSegments(['local', '100%zz'])).toBe('local/100%zz');
  });
});

describe('host check', () => {
  it('accepts loopback names with or without a port', () => {
    for (const host of [
      '127.0.0.1:3100',
      'localhost:3100',
      'LOCALHOST',
      '[::1]:3100',
      '127.0.0.1',
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('refuses everything else, including look-alikes', () => {
    for (const host of [
      null,
      '',
      'evil.example',
      'evil.example:3100',
      '127.0.0.1.evil.example',
      'localhost.evil.example:3100',
      '[::2]:3100',
      '0.0.0.0:3100',
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
