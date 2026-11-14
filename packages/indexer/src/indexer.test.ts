import { describe, expect, it } from 'vitest';
import { gitBlobSha, indexRepository, normalizeRepoPath } from './indexer.ts';
import { DEFAULT_LIMITS, type SourceFile } from './types.ts';

const encoder = new TextEncoder();

async function* memory(files: Record<string, string | Uint8Array>): AsyncGenerator<SourceFile> {
  for (const [path, value] of Object.entries(files)) {
    const content = typeof value === 'string' ? encoder.encode(value) : value;
    yield { path, size: content.byteLength, content };
  }
}

/** A small pnpm monorepo with a Python service and a Go tool, exercising every resolver. */
const monorepo: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'acme', private: true, devDependencies: { turbo: '2' } }),
  'tsconfig.base.json': '{ "compilerOptions": { "strict": true } }',
  'apps/web/package.json': JSON.stringify({
    name: '@acme/web',
    dependencies: { next: '15', react: '19', '@acme/ui': 'workspace:*' },
  }),
  'apps/web/tsconfig.json':
    '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
  'apps/web/src/app/page.tsx': `
    import { Button } from '@acme/ui';
    import { db } from '@/lib/db';
    import React from 'react';
    import { readFile } from 'node:fs/promises';
    // TODO: paginate results
    const s = "TODO: not a marker, it's a string";
    export default function Page() { return <Button />; }
  `,
  'apps/web/src/lib/db.ts': `import postgres from 'postgres'; // FIXME(ops): pool size\nexport const db = postgres();`,
  'packages/ui/package.json': JSON.stringify({
    name: '@acme/ui',
    exports: { '.': './src/index.ts' },
    dependencies: { react: '19' },
  }),
  'packages/ui/src/index.ts': `export * from './button.js';`,
  'packages/ui/src/button.tsx': `import { clsx } from 'clsx';\nexport const Button = () => null;`,
  'packages/ui/src/button.test.tsx': `import { Button } from './button';`,
  'services/api/pyproject.toml': '[project]\nname = "api"\ndependencies = ["fastapi", "PyYAML"]\n',
  'services/api/api/__init__.py': '',
  'services/api/api/main.py':
    'from fastapi import FastAPI\nfrom .routes import router\nimport yaml\nimport os\n# HACK: remove before launch\n',
  'services/api/api/routes.py': 'from . import models\n',
  'services/api/api/models.py': '"""TODO: docstrings are not comments"""\n',
  'tools/gen/go.mod': 'module example.com/gen\n\ngo 1.23\n',
  'tools/gen/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/gen/internal/tpl"\n)\n',
  'tools/gen/internal/tpl/tpl.go': 'package tpl\n',
  'README.md': '# Acme\n\nTODO: write docs\n',
  'node_modules/react/index.js': 'module.exports = {}',
  'apps/web/.next/cache.js': 'ignored',
  'logo.png': '\u0000PNG',
};

describe('indexRepository', () => {
  it('builds the cross-language import graph of a monorepo', async () => {
    const index = await indexRepository(memory(monorepo));

    expect(index.edges).toEqual([
      { from: 'apps/web/src/app/page.tsx', to: 'apps/web/src/lib/db.ts' },
      { from: 'apps/web/src/app/page.tsx', to: 'packages/ui/src/index.ts' },
      { from: 'packages/ui/src/button.test.tsx', to: 'packages/ui/src/button.tsx' },
      { from: 'packages/ui/src/index.ts', to: 'packages/ui/src/button.tsx' },
      { from: 'services/api/api/main.py', to: 'services/api/api/routes.py' },
      { from: 'services/api/api/routes.py', to: 'services/api/api/models.py' },
      { from: 'tools/gen/main.go', to: 'tools/gen/internal/tpl/tpl.go' },
    ]);
    expect(index.stats.imports.unresolved).toBe(0);
    expect(index.stats.imports.builtin).toBe(3); // node:fs/promises, os, fmt
  });

  it('groups files into package modules and weights module edges', async () => {
    const index = await indexRepository(memory(monorepo));
    expect(index.modules.map((m) => m.id)).toEqual([
      '(root)',
      'apps/web',
      'packages/ui',
      'services/api',
      'tools/gen',
    ]);
    expect(index.moduleEdges).toEqual([{ from: 'apps/web', to: 'packages/ui', weight: 1 }]);
    const page = index.files.find((f) => f.path === 'apps/web/src/app/page.tsx');
    expect(page).toMatchObject({ language: 'TypeScript', kind: 'source', module: 'apps/web' });
    expect(index.files.find((f) => f.path.endsWith('button.test.tsx'))?.kind).toBe('test');
  });

  it('reports external dependencies per ecosystem and whether a manifest declares them', async () => {
    const index = await indexRepository(memory(monorepo));
    expect(index.externalDependencies).toEqual([
      { name: 'clsx', ecosystem: 'npm', importedBy: 1, declared: false },
      { name: 'fastapi', ecosystem: 'pypi', importedBy: 1, declared: true },
      { name: 'postgres', ecosystem: 'npm', importedBy: 1, declared: false },
      { name: 'pyyaml', ecosystem: 'pypi', importedBy: 1, declared: true },
      { name: 'react', ecosystem: 'npm', importedBy: 1, declared: true },
    ]);
    expect(index.frameworks).toEqual(['FastAPI', 'Next.js', 'React']);
  });

  it('extracts TODO/FIXME/HACK markers from comments only', async () => {
    const index = await indexRepository(memory(monorepo));
    expect(index.markers).toEqual([
      { path: 'apps/web/src/app/page.tsx', line: 6, kind: 'TODO', text: 'paginate results' },
      { path: 'apps/web/src/lib/db.ts', line: 1, kind: 'FIXME', text: 'pool size' },
      { path: 'services/api/api/main.py', line: 5, kind: 'HACK', text: 'remove before launch' },
    ]);
  });

  it('skips dependency and build directories, and does not analyse binary files', async () => {
    const index = await indexRepository(memory(monorepo));
    const paths = index.files.map((f) => f.path);
    expect(paths).not.toContain('node_modules/react/index.js');
    expect(paths).not.toContain('apps/web/.next/cache.js');
    expect(index.files.find((f) => f.path === 'logo.png')).toMatchObject({
      kind: 'asset',
      lines: null,
    });
  });

  it('is deterministic regardless of the order files arrive in', async () => {
    const reversed = Object.fromEntries(Object.entries(monorepo).reverse());
    const a = await indexRepository(memory(monorepo));
    const b = await indexRepository(memory(reversed));
    const strip = (i: typeof a) => ({ ...i, stats: { ...i.stats, durationMs: 0 } });
    expect(strip(b)).toEqual(strip(a));
  });

  it('records the git blob SHA GitHub uses for the same content', async () => {
    // `git hash-object` of "hello\n" is ce013625030ba8dba906f756967f9e9ca394464a.
    expect(gitBlobSha(encoder.encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    const index = await indexRepository(memory({ 'a.txt': 'hello\n' }));
    expect(index.files[0]?.blobSha).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('refuses unsafe or malformed paths', async () => {
    expect(normalizeRepoPath('src\\win\\path.ts')).toBe('src/win/path.ts');
    expect(normalizeRepoPath('./x.ts')).toBe('x.ts');
    for (const bad of [
      '../etc/passwd',
      '/abs.ts',
      'C:/x.ts',
      'a//b.ts',
      'a/./b',
      `${'x'.repeat(1201)}`,
    ]) {
      expect(normalizeRepoPath(bad)).toBeNull();
    }
    const index = await indexRepository(memory({ '../escape.ts': 'x', 'ok.ts': 'y' }));
    expect(index.files.map((f) => f.path)).toEqual(['ok.ts']);
  });

  it('marks the result truncated when a limit is hit, instead of failing', async () => {
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.ts`, 'x']));
    const byCount = await indexRepository(memory(files), { ...DEFAULT_LIMITS, maxFiles: 4 });
    expect(byCount.files).toHaveLength(4);
    expect(byCount.stats.truncated).toBe(true);

    const byBytes = await indexRepository(memory(files), { ...DEFAULT_LIMITS, maxTotalBytes: 3 });
    expect(byBytes.files).toHaveLength(10);
    expect(byBytes.stats.analysedFiles).toBe(3);
    expect(byBytes.stats.truncated).toBe(true);
  });

  it('lists files over the per-file limit without reading them', async () => {
    const index = await indexRepository(memory({ 'big.ts': 'import x from "./x";'.repeat(10) }), {
      ...DEFAULT_LIMITS,
      maxFileBytes: 10,
    });
    expect(index.files[0]).toMatchObject({ path: 'big.ts', lines: null, blobSha: null });
    expect(index.stats.imports.total).toBe(0);
  });

  it('keeps lockfiles out of line counts', async () => {
    const index = await indexRepository(
      memory({ 'pnpm-lock.yaml': 'a: 1\n'.repeat(1000), 'a.ts': 'x\n' }),
    );
    expect(index.stats.lines).toBe(1);
    expect(index.stats.languages).toEqual({ TypeScript: { files: 1, lines: 1 } });
  });

  it('keeps at most maxMarkers markers', async () => {
    const index = await indexRepository(memory({ 'a.ts': '// TODO one\n'.repeat(50) }), {
      ...DEFAULT_LIMITS,
      maxMarkers: 5,
    });
    expect(index.markers).toHaveLength(5);
  });
});
