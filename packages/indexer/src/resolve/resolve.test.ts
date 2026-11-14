import { describe, expect, it } from 'vitest';
import { GoResolver } from './go.ts';
import { JsResolver, packageName, parseJsonc } from './js.ts';
import { joinPath } from './paths.ts';
import { PythonResolver } from './python.ts';

describe('joinPath', () => {
  it('normalises and refuses to escape the root', () => {
    expect(joinPath('a/b', '../c/./d')).toBe('a/c/d');
    expect(joinPath('', 'x')).toBe('x');
    expect(joinPath('a', '../../x')).toBeNull();
  });
});

describe('packageName', () => {
  it.each([
    ['lodash', 'lodash'],
    ['lodash/fp', 'lodash'],
    ['@scope/pkg', '@scope/pkg'],
    ['@scope/pkg/deep/path', '@scope/pkg'],
    ['@/components/x', null],
    ['~/utils', null],
    ['#internal', null],
  ])('%s → %s', (spec, name) => {
    expect(packageName(spec)).toBe(name);
  });
});

describe('parseJsonc', () => {
  it('accepts comments and trailing commas but keeps // inside strings', () => {
    expect(parseJsonc('{ // c\n "a": "http://x", /* b */ "c": [1,2,], }')).toEqual({
      a: 'http://x',
      c: [1, 2],
    });
  });
});

function js(files: string[], configs: Record<string, string> = {}, packages = [] as never[]) {
  return new JsResolver({
    files: new Set(files),
    packages,
    configs: new Map(Object.entries(configs)),
  });
}

describe('JsResolver', () => {
  it('resolves relative imports with Node/TypeScript lookup rules', () => {
    const r = js(['src/a.ts', 'src/b/index.tsx', 'src/c.js', 'src/d.ts', 'src/styles.css']);
    expect(r.resolve('src/x.ts', './a')).toEqual({ kind: 'internal', path: 'src/a.ts' });
    expect(r.resolve('src/x.ts', './b')).toEqual({ kind: 'internal', path: 'src/b/index.tsx' });
    expect(r.resolve('src/x.ts', './c.js')).toEqual({ kind: 'internal', path: 'src/c.js' });
    // TypeScript ESM: `./d.js` in source means `./d.ts`.
    expect(r.resolve('src/x.ts', './d.js')).toEqual({ kind: 'internal', path: 'src/d.ts' });
    expect(r.resolve('src/x.ts', './styles.css')).toEqual({
      kind: 'internal',
      path: 'src/styles.css',
    });
    expect(r.resolve('src/x.ts', './icon.svg?raw')).toEqual({ kind: 'unresolved' });
    expect(r.resolve('src/x.ts', './missing')).toEqual({ kind: 'unresolved' });
    expect(r.resolve('src/x.ts', '../../outside')).toEqual({ kind: 'unresolved' });
  });

  it('resolves a directory import through its package.json main, like Node', () => {
    const r = new JsResolver({
      files: new Set([
        'fastify.js',
        'index.js',
        'test/a.test.js',
        'lib/util/main.js',
        'loop/index.js',
      ]),
      packages: [
        { dir: '', name: 'fastify', exports: null, main: 'fastify.js', module: null, types: null },
        { dir: 'lib/util', name: null, exports: null, main: './main', module: null, types: null },
        { dir: 'loop', name: null, exports: null, main: '.', module: null, types: null },
      ],
      configs: new Map(),
    });
    expect(r.resolve('test/a.test.js', '..')).toEqual({ kind: 'internal', path: 'fastify.js' });
    expect(r.resolve('test/a.test.js', '../lib/util')).toEqual({
      kind: 'internal',
      path: 'lib/util/main.js',
    });
    // `main: "."` points back at the directory: falls through to index.js instead of looping.
    expect(r.resolve('test/a.test.js', '../loop')).toEqual({
      kind: 'internal',
      path: 'loop/index.js',
    });
  });

  it('classifies builtins and external packages', () => {
    const r = js([]);
    expect(r.resolve('a.ts', 'node:fs')).toEqual({ kind: 'builtin' });
    expect(r.resolve('a.ts', 'path')).toEqual({ kind: 'builtin' });
    expect(r.resolve('a.ts', 'fs/promises')).toEqual({ kind: 'builtin' });
    expect(r.resolve('a.ts', 'virtual:pwa')).toEqual({ kind: 'builtin' });
    expect(r.resolve('a.ts', 'react-dom/client')).toEqual({ kind: 'external', name: 'react-dom' });
    expect(r.resolve('a.ts', '@tanstack/react-query')).toEqual({
      kind: 'external',
      name: '@tanstack/react-query',
    });
    expect(r.resolve('a.ts', '@/missing-alias')).toEqual({ kind: 'unresolved' });
  });

  it('applies tsconfig paths from the nearest config, following relative extends', () => {
    const r = js(['apps/web/src/lib/db.ts', 'apps/web/src/components/Button.tsx', 'shared/x.ts'], {
      'tsconfig.base.json': '{ "compilerOptions": { "paths": { "@shared/*": ["shared/*"] } } }',
      'apps/web/tsconfig.json': `{
        // Next.js style
        "extends": "../../tsconfig.base.json",
        "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } },
      }`,
    });
    expect(r.resolve('apps/web/src/app/page.tsx', '@/lib/db')).toEqual({
      kind: 'internal',
      path: 'apps/web/src/lib/db.ts',
    });
    // baseUrl alone also resolves bare specifiers that exist as files.
    expect(r.resolve('apps/web/src/app/page.tsx', 'src/components/Button')).toEqual({
      kind: 'internal',
      path: 'apps/web/src/components/Button.tsx',
    });
    // The child config replaced `paths`, so the parent's alias no longer applies here; a
    // scoped-looking name that matches nothing is then an npm package, as TypeScript would see it.
    expect(r.resolve('apps/web/src/app/page.tsx', '@shared/x')).toEqual({
      kind: 'external',
      name: '@shared/x',
    });
  });

  it('resolves inherited paths relative to the config that defined them', () => {
    const r = js(['shared/x.ts'], {
      'tsconfig.base.json': '{ "compilerOptions": { "paths": { "@shared/*": ["shared/*"] } } }',
      'apps/api/tsconfig.json': '{ "extends": "../../tsconfig.base" }',
    });
    expect(r.resolve('apps/api/src/main.ts', '@shared/x')).toEqual({
      kind: 'internal',
      path: 'shared/x.ts',
    });
  });

  it('survives extends cycles and broken configs', () => {
    const r = js(['a.ts'], {
      'tsconfig.json': '{ "extends": "./tsconfig.other.json" }',
      'tsconfig.other.json': '{ "extends": "./tsconfig.json" }',
      'pkg/tsconfig.json': '{ not json',
    });
    expect(r.resolve('x.ts', './a')).toEqual({ kind: 'internal', path: 'a.ts' });
    expect(r.resolve('pkg/x.ts', 'lodash')).toEqual({ kind: 'external', name: 'lodash' });
  });

  it('resolves workspace packages through exports, falling back from build output to source', () => {
    const packages = [
      {
        dir: 'packages/core',
        name: '@acme/core',
        exports: { '.': './src/index.ts', './testing': './src/testing.ts' },
        main: null,
        module: null,
        types: null,
      },
      {
        dir: 'packages/ui',
        name: '@acme/ui',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
        main: null,
        module: null,
        types: null,
      },
      {
        dir: 'packages/legacy',
        name: 'legacy',
        exports: null,
        main: 'lib/main.js',
        module: null,
        types: null,
      },
      {
        dir: 'packages/empty',
        name: 'empty-pkg',
        exports: null,
        main: null,
        module: null,
        types: null,
      },
    ];
    const r = new JsResolver({
      files: new Set([
        'packages/core/src/index.ts',
        'packages/core/src/testing.ts',
        'packages/ui/src/index.tsx',
        'packages/legacy/src/main.ts',
        'packages/empty/package.json',
      ]),
      packages,
      configs: new Map(),
    });
    expect(r.resolve('apps/a.ts', '@acme/core')).toEqual({
      kind: 'internal',
      path: 'packages/core/src/index.ts',
    });
    expect(r.resolve('apps/a.ts', '@acme/core/testing')).toEqual({
      kind: 'internal',
      path: 'packages/core/src/testing.ts',
    });
    expect(r.resolve('apps/a.ts', '@acme/ui')).toEqual({
      kind: 'internal',
      path: 'packages/ui/src/index.tsx',
    });
    expect(r.resolve('apps/a.ts', 'legacy')).toEqual({
      kind: 'internal',
      path: 'packages/legacy/src/main.ts',
    });
    // Entry not found: still an internal dependency, pointing at the package manifest.
    expect(r.resolve('apps/a.ts', 'empty-pkg')).toEqual({
      kind: 'internal',
      path: 'packages/empty/package.json',
    });
  });
});

describe('PythonResolver', () => {
  const files = new Set([
    'src/app/__init__.py',
    'src/app/models.py',
    'src/app/api/__init__.py',
    'src/app/api/routes.py',
    'src/app/api/deps.py',
    'tools/script.py',
  ]);
  const r = new PythonResolver(files, ['']);

  it('resolves absolute imports from the src layout', () => {
    expect(r.resolve('tools/script.py', { specifier: 'app.models', line: 1 })).toEqual([
      { kind: 'internal', path: 'src/app/models.py' },
    ]);
    expect(r.resolve('tools/script.py', { specifier: 'app.api', line: 1 })).toEqual([
      { kind: 'internal', path: 'src/app/api/__init__.py' },
    ]);
  });

  it('treats a trailing attribute in `import a.b.c` as part of the closest module', () => {
    expect(r.resolve('x.py', { specifier: 'app.models.User', line: 1 })).toEqual([
      { kind: 'internal', path: 'src/app/models.py' },
    ]);
  });

  it('resolves relative imports and submodule names', () => {
    expect(
      r.resolve('src/app/api/routes.py', { specifier: '.', line: 1, names: ['deps'] }),
    ).toEqual([{ kind: 'internal', path: 'src/app/api/deps.py' }]);
    expect(
      r.resolve('src/app/api/routes.py', { specifier: '..models', line: 1, names: ['User'] }),
    ).toEqual([{ kind: 'internal', path: 'src/app/models.py' }]);
    expect(
      r.resolve('src/app/api/routes.py', { specifier: '..', line: 1, names: ['models', 'helper'] }),
    ).toEqual([
      { kind: 'internal', path: 'src/app/models.py' },
      { kind: 'internal', path: 'src/app/__init__.py' },
    ]);
    expect(r.resolve('src/app/models.py', { specifier: '....', line: 1, names: ['x'] })).toEqual([
      { kind: 'unresolved' },
    ]);
  });

  it('separates the standard library from third-party distributions', () => {
    expect(r.resolve('x.py', { specifier: 'os.path', line: 1 })).toEqual([{ kind: 'builtin' }]);
    expect(r.resolve('x.py', { specifier: 'yaml', line: 1 })).toEqual([
      { kind: 'external', name: 'pyyaml' },
    ]);
    expect(
      r.resolve('x.py', { specifier: 'fastapi.routing', line: 1, names: ['APIRouter'] }),
    ).toEqual([{ kind: 'external', name: 'fastapi' }]);
  });
});

describe('GoResolver', () => {
  const r = new GoResolver(
    new Set([
      'go.mod',
      'cmd/api/main.go',
      'internal/store/store.go',
      'internal/store/sql.go',
      'internal/store/store_test.go',
      'internal/util/a.go',
      'internal/util/b.go',
      'tools/go.mod',
      'tools/gen/gen.go',
    ]),
    [
      { dir: '', path: 'example.com/app', requires: ['github.com/jackc/pgx/v5'] },
      { dir: 'tools', path: 'example.com/app/tools', requires: [] },
    ],
  );

  it('maps module-internal packages to a representative file', () => {
    expect(r.resolve('example.com/app/internal/store')).toEqual({
      kind: 'internal',
      path: 'internal/store/store.go',
    });
    expect(r.resolve('example.com/app/internal/util')).toEqual({
      kind: 'internal',
      path: 'internal/util/a.go',
    });
  });

  it('prefers the most specific (nested) module', () => {
    expect(r.resolve('example.com/app/tools/gen')).toEqual({
      kind: 'internal',
      path: 'tools/gen/gen.go',
    });
  });

  it('classifies the standard library and required modules', () => {
    expect(r.resolve('net/http')).toEqual({ kind: 'builtin' });
    expect(r.resolve('github.com/jackc/pgx/v5/pgxpool')).toEqual({
      kind: 'external',
      name: 'github.com/jackc/pgx/v5',
    });
    expect(r.resolve('golang.org/x/sync/errgroup')).toEqual({
      kind: 'external',
      name: 'golang.org/x/sync',
    });
    expect(r.resolve('example.com/app/missing')).toEqual({ kind: 'unresolved' });
  });
});
