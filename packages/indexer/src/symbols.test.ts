import { describe, expect, it } from 'vitest';
import { readmeExcerpt } from './indexer.ts';
import { scanGo } from './lexers/go.ts';
import { scanJavaScript } from './lexers/js.ts';
import { scanPython } from './lexers/python.ts';

describe('exported symbols', () => {
  it('JS/TS: declarations, defaults, local export lists, CommonJS', () => {
    const src = `
      export function createSession() {}
      export async function* stream() {}
      export default class AuthGuard {}
      export const MAX_AGE = 1, other = 2;
      export interface SessionStore {}
      export type Token = string;
      export enum Role { Admin }
      export declare abstract class Base {}
      const a = 1, b = 2;
      export { a, b as renamed };
      export { fromElsewhere } from './x';
      export default function () {}
      exports.legacyHelper = () => {};
      function notExported() {}
    `;
    expect(scanJavaScript(src).symbols).toEqual([
      'createSession',
      'stream',
      'AuthGuard',
      'MAX_AGE',
      'SessionStore',
      'Token',
      'Role',
      'Base',
      'a',
      'renamed',
      'legacyHelper',
    ]);
  });

  it('Python: top-level public def/class only', () => {
    const src = `
def handler(event):
    def inner(): pass
async def fetch_user(): pass
class PaymentService:
    def method(self): pass
def _private(): pass
"""
def in_docstring(): pass
"""
`;
    expect(scanPython(src).symbols).toEqual(['handler', 'fetch_user', 'PaymentService']);
  });

  it('Go: exported funcs, methods, and types', () => {
    const src = `package store
type Store struct{}
type internal struct{}
func New() *Store { return nil }
func (s *Store) Get(id string) {}
func (s *Store) put() {}
func helper() {}
`;
    expect(scanGo(src).symbols).toEqual(['Store', 'New', 'Get']);
  });

  it('caps the number of symbols per file', () => {
    const src = Array.from({ length: 100 }, (_, i) => `export const s${i} = ${i};`).join('\n');
    expect(scanJavaScript(src).symbols).toHaveLength(30);
  });
});

describe('readmeExcerpt', () => {
  it('keeps the title and first paragraph as plain text', () => {
    const text = `<p align="center"><img src="logo.png"></p>

# Acme Payments

[![CI](https://x/badge.svg)](https://x) ![npm](https://img/x.svg)

Accept **card payments** with [Stripe](https://stripe.com) and reconcile them nightly.
Supports refunds.

## Install
npm i acme`;
    expect(readmeExcerpt(text)).toBe(
      'Acme Payments — Accept card payments with Stripe and reconcile them nightly. — Supports refunds.',
    );
  });

  it('returns null for an empty README and bounds the length', () => {
    expect(readmeExcerpt('\n\n')).toBeNull();
    expect(Array.from(readmeExcerpt(`# T\n\n${'word '.repeat(500)}`) ?? '').length).toBe(400);
  });
});
