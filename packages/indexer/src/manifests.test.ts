import { describe, expect, it } from 'vitest';
import { detectFrameworks, parseManifest, pep508Name } from './manifests.ts';

describe('parseManifest', () => {
  it('reads package.json dependencies, scripts, and resolution fields', () => {
    const parsed = parseManifest(
      'apps/web/package.json',
      JSON.stringify({
        name: '@acme/web',
        main: './dist/index.js',
        exports: { '.': './src/index.ts' },
        dependencies: { next: '15', react: '19' },
        peerDependencies: { react: '19', 'react-dom': '19' },
        devDependencies: { vitest: '5' },
        scripts: { dev: 'next dev', build: 'next build' },
      }),
    );
    expect(parsed?.manifest).toEqual({
      path: 'apps/web/package.json',
      ecosystem: 'npm',
      name: '@acme/web',
      dependencies: ['next', 'react', 'react-dom'],
      devDependencies: ['vitest'],
      scripts: ['build', 'dev'],
    });
    expect(parsed?.npm).toMatchObject({
      dir: 'apps/web',
      name: '@acme/web',
      main: './dist/index.js',
    });
  });

  it('reads PEP 621 and Poetry pyproject files', () => {
    const pep621 = parseManifest(
      'pyproject.toml',
      `[project]
name = "svc"
dependencies = ["FastAPI>=0.110", "requests[socks]; python_version>'3.8'"]
[project.optional-dependencies]
dev = ["pytest"]
[dependency-groups]
lint = ["ruff"]
[project.scripts]
svc = "svc.main:run"
`,
    );
    expect(pep621?.manifest).toMatchObject({
      name: 'svc',
      dependencies: ['fastapi', 'requests'],
      devDependencies: ['pytest', 'ruff'],
      scripts: ['svc'],
    });

    const poetry = parseManifest(
      'pyproject.toml',
      `[tool.poetry]
name = "legacy"
[tool.poetry.dependencies]
python = "^3.11"
django = "^5"
[tool.poetry.group.dev.dependencies]
black = "*"
`,
    );
    expect(poetry?.manifest).toMatchObject({
      name: 'legacy',
      dependencies: ['django'],
      devDependencies: ['black'],
    });
  });

  it('reads requirements files, treating dev/test ones as dev dependencies', () => {
    const text = '# comment\nDjango==5.0  # pinned\n-r base.txt\n\ncelery[redis]>=5\n';
    expect(parseManifest('requirements.txt', text)?.manifest.dependencies).toEqual([
      'celery',
      'django',
    ]);
    expect(parseManifest('requirements-dev.txt', 'pytest\n')?.manifest.devDependencies).toEqual([
      'pytest',
    ]);
  });

  it('reads go.mod modules and requirements', () => {
    const parsed = parseManifest(
      'go.mod',
      `module example.com/app

go 1.23

require github.com/gin-gonic/gin v1.10.0

require (
	github.com/jackc/pgx/v5 v5.7.1
	golang.org/x/sync v0.8.0 // indirect
	// github.com/commented/out v1.0.0
)
`,
    );
    expect(parsed?.goModule).toBe('example.com/app');
    expect(parsed?.manifest.dependencies).toEqual([
      'github.com/gin-gonic/gin',
      'github.com/jackc/pgx/v5',
      'golang.org/x/sync',
    ]);
  });

  it('reads Cargo.toml', () => {
    const parsed = parseManifest(
      'crates/core/Cargo.toml',
      '[package]\nname = "core"\n[dependencies]\ntokio = { version = "1" }\nserde = "1"\n[dev-dependencies]\ninsta = "1"\n',
    );
    expect(parsed?.manifest).toMatchObject({
      ecosystem: 'cargo',
      name: 'core',
      dependencies: ['serde', 'tokio'],
      devDependencies: ['insta'],
    });
  });

  it('returns null for malformed manifests instead of throwing', () => {
    expect(parseManifest('package.json', '{ nope')).toBeNull();
    expect(parseManifest('pyproject.toml', '[[[')).toBeNull();
  });

  it('extracts distribution names from PEP 508 strings', () => {
    expect(pep508Name('Typing_Extensions >= 4')).toBe('typing_extensions');
    expect(pep508Name('  # nothing')).toBeNull();
  });
});

describe('detectFrameworks', () => {
  it('recognises frameworks per ecosystem only', () => {
    const manifests = [
      {
        path: 'package.json',
        ecosystem: 'npm' as const,
        name: null,
        dependencies: ['next', 'react'],
        devDependencies: [],
        scripts: [],
      },
      {
        path: 'pyproject.toml',
        ecosystem: 'pypi' as const,
        name: null,
        dependencies: ['fastapi', 'next'],
        devDependencies: [],
        scripts: [],
      },
    ];
    expect(detectFrameworks(manifests)).toEqual(['FastAPI', 'Next.js', 'React']);
  });
});

describe('detectFrameworks scope', () => {
  it('ignores manifests of examples, fixtures, and tests', () => {
    const m = (path: string, dependencies: string[]) => ({
      path,
      ecosystem: 'npm' as const,
      name: null,
      dependencies,
      devDependencies: [],
      scripts: [],
    });
    expect(
      detectFrameworks([
        m('packages/next/package.json', ['react']),
        m('examples/with-expo/package.json', ['expo']),
        m('test/fixtures/app/package.json', ['express']),
      ]),
    ).toEqual(['React']);
  });
});
