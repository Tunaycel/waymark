import { parse as parseToml } from 'smol-toml';
import { basename, dirname } from './languages.ts';
import type { Ecosystem, Manifest } from './types.ts';

/** Manifest file names the indexer reads in full (they also mark package roots). */
export const MANIFEST_FILES = new Set(['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']);

export function isManifestPath(path: string): boolean {
  const name = basename(path);
  return MANIFEST_FILES.has(name) || /^requirements[\w.-]*\.txt$/.test(name);
}

/** What resolvers need from a parsed `package.json`, beyond the public manifest summary. */
export interface NpmPackage {
  dir: string;
  /** `null` for unnamed package.json files, which still steer directory imports via `main`. */
  name: string | null;
  exports: unknown;
  main: string | null;
  module: string | null;
  types: string | null;
}

export interface ParsedManifest {
  manifest: Manifest;
  npm?: NpmPackage;
  /** `module` path from go.mod. */
  goModule?: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const keys = (value: unknown) => Object.keys(record(value)).sort();
const str = (value: unknown) => (typeof value === 'string' ? value : null);

/** PEP 508 requirement → distribution name (`requests[socks]>=2; python_version>"3"` → `requests`). */
export function pep508Name(requirement: string): string | null {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement);
  return match ? (match[1] as string).toLowerCase() : null;
}

function manifest(path: string, ecosystem: Ecosystem, fields: Partial<Manifest>): Manifest {
  return {
    path,
    ecosystem,
    name: fields.name ?? null,
    dependencies: fields.dependencies ?? [],
    devDependencies: fields.devDependencies ?? [],
    scripts: fields.scripts ?? [],
  };
}

/** Parses a manifest. Returns `null` for files that are malformed; one bad file never fails a run. */
export function parseManifest(path: string, text: string): ParsedManifest | null {
  const name = basename(path);
  try {
    if (name === 'package.json') {
      const json = record(JSON.parse(text));
      const pkgName = str(json.name);
      const parsed: ParsedManifest = {
        manifest: manifest(path, 'npm', {
          name: pkgName,
          dependencies: [...new Set([...keys(json.dependencies), ...keys(json.peerDependencies)])],
          devDependencies: keys(json.devDependencies),
          scripts: keys(json.scripts),
        }),
      };
      parsed.npm = {
        dir: dirname(path),
        name: pkgName,
        exports: json.exports ?? null,
        main: str(json.main),
        module: str(json.module),
        types: str(json.types) ?? str(json.typings),
      };
      return parsed;
    }

    if (name === 'pyproject.toml') {
      const toml = record(parseToml(text));
      const project = record(toml.project);
      const poetry = record(record(toml.tool).poetry);
      const deps = Array.isArray(project.dependencies)
        ? project.dependencies.filter((d): d is string => typeof d === 'string').map(pep508Name)
        : keys(poetry.dependencies).filter((d) => d !== 'python');
      const optional = Object.values(record(project['optional-dependencies']))
        .flat()
        .filter((d): d is string => typeof d === 'string')
        .map(pep508Name);
      const groups = Object.values(record(toml['dependency-groups']))
        .flat()
        .filter((d): d is string => typeof d === 'string')
        .map(pep508Name);
      const poetryDev = Object.values(record(poetry.group)).flatMap((g) =>
        keys(record(g).dependencies),
      );
      return {
        manifest: manifest(path, 'pypi', {
          name: str(project.name) ?? str(poetry.name),
          dependencies: uniqueNames(deps),
          devDependencies: uniqueNames([...optional, ...groups, ...poetryDev]),
          scripts: keys(project.scripts),
        }),
      };
    }

    if (/^requirements[\w.-]*\.txt$/.test(name)) {
      const deps = text
        .split('\n')
        .map((l) => l.replace(/#.*/, '').trim())
        .filter((l) => l && !l.startsWith('-'))
        .map(pep508Name);
      // requirements-dev.txt, requirements-docs.txt, requirements-tests.txt, …: not runtime.
      const dev = /dev|test|lint|doc|ci|bench|example|tutorial|typing/.test(name);
      return {
        manifest: manifest(path, 'pypi', {
          dependencies: dev ? [] : uniqueNames(deps),
          devDependencies: dev ? uniqueNames(deps) : [],
        }),
      };
    }

    if (name === 'go.mod') {
      // Line by line: whole-file regexes backtrack badly on hostile input.
      let module: string | null = null;
      const requires = new Set<string>();
      let inRequire = false;
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\/\/.*/, '').trim();
        if (line === '') continue;
        const fields = line.split(/[ \t]+/);
        if (inRequire) {
          if (line.startsWith(')')) inRequire = false;
          else if (fields[1]?.startsWith('v')) requires.add(fields[0] as string);
          continue;
        }
        if (fields[0] === 'module' && fields[1] && module === null) module = fields[1];
        else if (fields[0] === 'require') {
          if (fields[1] === '(' || line === 'require(') inRequire = true;
          else if (fields[1] && fields[2]?.startsWith('v')) requires.add(fields[1]);
        }
      }
      const parsed: ParsedManifest = {
        manifest: manifest(path, 'go', { name: module, dependencies: [...requires].sort() }),
      };
      if (module) parsed.goModule = module;
      return parsed;
    }

    if (name === 'Cargo.toml') {
      const toml = record(parseToml(text));
      return {
        manifest: manifest(path, 'cargo', {
          name: str(record(toml.package).name),
          dependencies: keys(toml.dependencies),
          devDependencies: keys(toml['dev-dependencies']),
        }),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function uniqueNames(names: (string | null)[]): string[] {
  return [...new Set(names.filter((n): n is string => n !== null))].sort();
}

/** Well-known frameworks, detected from declared dependencies. */
const FRAMEWORKS: [Ecosystem, string, string][] = [
  ['npm', 'next', 'Next.js'],
  ['npm', 'react', 'React'],
  ['npm', 'react-native', 'React Native'],
  ['npm', 'expo', 'Expo'],
  ['npm', 'vue', 'Vue'],
  ['npm', 'nuxt', 'Nuxt'],
  ['npm', 'svelte', 'Svelte'],
  ['npm', '@sveltejs/kit', 'SvelteKit'],
  ['npm', '@angular/core', 'Angular'],
  ['npm', 'astro', 'Astro'],
  ['npm', 'solid-js', 'Solid'],
  ['npm', 'electron', 'Electron'],
  ['npm', 'express', 'Express'],
  ['npm', 'fastify', 'Fastify'],
  ['npm', 'hono', 'Hono'],
  ['npm', '@nestjs/core', 'NestJS'],
  ['npm', 'koa', 'Koa'],
  ['npm', 'drizzle-orm', 'Drizzle'],
  ['npm', 'prisma', 'Prisma'],
  ['npm', '@prisma/client', 'Prisma'],
  ['npm', 'bullmq', 'BullMQ'],
  ['npm', 'tailwindcss', 'Tailwind CSS'],
  ['npm', 'vite', 'Vite'],
  ['pypi', 'django', 'Django'],
  ['pypi', 'flask', 'Flask'],
  ['pypi', 'fastapi', 'FastAPI'],
  ['pypi', 'sqlalchemy', 'SQLAlchemy'],
  ['pypi', 'celery', 'Celery'],
  ['pypi', 'pytorch', 'PyTorch'],
  ['pypi', 'torch', 'PyTorch'],
  ['pypi', 'tensorflow', 'TensorFlow'],
  ['pypi', 'pandas', 'pandas'],
  ['pypi', 'streamlit', 'Streamlit'],
  ['go', 'github.com/gin-gonic/gin', 'Gin'],
  ['go', 'github.com/labstack/echo/v4', 'Echo'],
  ['go', 'github.com/gofiber/fiber/v2', 'Fiber'],
  ['go', 'github.com/go-chi/chi/v5', 'chi'],
  ['cargo', 'actix-web', 'Actix Web'],
  ['cargo', 'axum', 'Axum'],
  ['cargo', 'tokio', 'Tokio'],
  ['cargo', 'tauri', 'Tauri'],
  ['cargo', 'bevy', 'Bevy'],
];

/** Build tooling is a devDependency by convention; everything else must be a runtime dependency. */
const DEV_TOOLING = new Set(['Vite', 'Tailwind CSS', 'Prisma']);

/**
 * Frameworks the project is built on. Only runtime dependencies of the project's own manifests
 * count (plus build tooling), so a library tested against Express, documented with Flask examples,
 * or shipping an Expo example app is not labelled as any of them.
 */
/** Manifests of examples, fixtures, tests, and templates describe something else than the project. */
const NOT_THE_PROJECT =
  /(^|\/)(examples?|samples?|demos?|fixtures?|__fixtures__|testdata|tests?|__tests__|e2e|templates?|bench(marks?)?|docs?)\//;

export function detectFrameworks(manifests: Manifest[]): string[] {
  const found = new Set<string>();
  for (const m of manifests) {
    if (NOT_THE_PROJECT.test(m.path)) continue;
    const runtime = new Set(m.dependencies);
    const dev = new Set(m.devDependencies);
    for (const [ecosystem, dep, label] of FRAMEWORKS) {
      if (m.ecosystem !== ecosystem) continue;
      if (runtime.has(dep) || (DEV_TOOLING.has(label) && dev.has(dep))) found.add(label);
    }
  }
  return [...found].sort();
}
