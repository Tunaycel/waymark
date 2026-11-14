import { builtinModules } from 'node:module';
import { basename, dirname, isIgnoredPath } from '../languages.ts';
import type { NpmPackage } from '../manifests.ts';
import {
  ancestors,
  BUILTIN,
  external,
  IGNORED,
  internal,
  joinPath,
  type Resolution,
  UNRESOLVED,
} from './paths.ts';

const EXTENSIONS = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.vue',
  '.svelte',
  '.json',
];
const INDEX_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/** TypeScript's ESM convention: `import './x.js'` refers to `x.ts`. */
const TS_SOURCE_FOR: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
};

const NODE_BUILTINS = new Set(builtinModules);

/** Strips `//` and `/* *\/` comments and trailing commas so tsconfig files (JSONC) parse as JSON. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      out += text.slice(start, i);
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface PathsConfig {
  /** Directory that bare specifiers resolve against (`baseUrl`), if set. */
  baseUrlDir: string | null;
  paths: Record<string, string[]> | null;
  /** Directory `paths` targets are relative to: `baseUrl`, else the config that defined `paths`. */
  pathsDir: string;
}

const EMPTY_CONFIG: PathsConfig = { baseUrlDir: null, paths: null, pathsDir: '' };

export interface JsResolverInput {
  files: ReadonlySet<string>;
  /** Workspace packages (every package.json with a `name`). */
  packages: NpmPackage[];
  /** Contents of every `tsconfig*.json` / `jsconfig*.json` in the repository. */
  configs: ReadonlyMap<string, string>;
}

export class JsResolver {
  private readonly files: ReadonlySet<string>;
  private readonly packages = new Map<string, NpmPackage>();
  private readonly packagesByDir = new Map<string, NpmPackage>();
  private readonly configs: ReadonlyMap<string, string>;
  private readonly configForDir = new Map<string, PathsConfig>();
  private readonly loadedConfigs = new Map<string, PathsConfig | null>();

  constructor(input: JsResolverInput) {
    this.files = input.files;
    this.configs = input.configs;
    for (const pkg of input.packages) {
      this.packagesByDir.set(pkg.dir, pkg);
      if (pkg.name === null) continue;
      // With duplicate names (fixtures, examples), the shallowest package wins.
      const existing = this.packages.get(pkg.name);
      const depth = pkg.dir.split('/').length;
      const existingDepth = existing?.dir.split('/').length ?? Number.POSITIVE_INFINITY;
      // Same depth: alphabetical, so the choice never depends on archive order.
      if (depth < existingDepth || (depth === existingDepth && pkg.dir < (existing?.dir ?? ''))) {
        this.packages.set(pkg.name, pkg);
      }
    }
  }

  resolve(fromFile: string, specifier: string): Resolution {
    // Bundler query suffixes (`./icon.svg?raw`) aren't part of the path.
    const spec = specifier.replace(/\?.*$/, '');
    if (spec === '') return UNRESOLVED;
    if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return BUILTIN;
    if (/^[a-z][\w+.-]*:/i.test(specifier)) return BUILTIN; // virtual:, data:, https://
    const dir = dirname(fromFile);

    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      const target = joinPath(dir, spec);
      const file = target === null ? null : this.tryFile(target);
      if (file) return internal(file);
      // `./dist/x`, `../node_modules/y`: real targets, just never indexed.
      return target !== null && isIgnoredPath(`${target}/_`) ? IGNORED : UNRESOLVED;
    }
    if (spec.startsWith('/')) return UNRESOLVED;

    const config = this.configFor(dir);
    const aliased = this.matchPaths(config, spec);
    if (aliased) return internal(aliased);

    const pkg = this.workspacePackage(spec);
    if (pkg) return pkg;

    if (config.baseUrlDir !== null) {
      const target = joinPath(config.baseUrlDir, spec);
      const file = target === null ? null : this.tryFile(target);
      if (file) return internal(file);
    }

    const name = packageName(spec);
    if (name === null) return UNRESOLVED; // `@/x`, `~/x`, `#x` aliases that matched nothing
    if (NODE_BUILTINS.has(name)) return BUILTIN;
    return external(name);
  }

  /**
   * Node/TypeScript file lookup: exact file, TS source for `.js`, added extensions, then the path
   * as a directory: its package.json entry (`require('..')`), then `index` files.
   */
  tryFile(base: string, depth = 0): string | null {
    if (this.files.has(base)) return base;
    const dot = base.lastIndexOf('.');
    const ext = dot > base.lastIndexOf('/') ? base.slice(dot) : '';
    for (const replacement of TS_SOURCE_FOR[ext] ?? []) {
      const candidate = base.slice(0, dot) + replacement;
      if (this.files.has(candidate)) return candidate;
    }
    for (const e of EXTENSIONS) if (this.files.has(base + e)) return base + e;
    const pkg = this.packagesByDir.get(base);
    if (pkg && depth < 4) {
      // `main: "."` or `"./"` would point back here; the depth guard ends that loop.
      const entry = this.packageEntry(pkg, '', depth + 1);
      if (entry) return entry;
    }
    const prefix = base === '' ? '' : `${base}/`;
    for (const e of INDEX_EXTENSIONS) {
      if (this.files.has(`${prefix}index${e}`)) return `${prefix}index${e}`;
    }
    return null;
  }

  private workspacePackage(spec: string): Resolution | null {
    const name = packageName(spec);
    if (name === null) return null;
    const pkg = this.packages.get(name);
    if (!pkg) return null;
    const subpath = spec.slice(name.length).replace(/^\//, '');
    const file = this.packageEntry(pkg, subpath);
    // Known workspace package whose entry can't be located: still an internal dependency on it.
    return internal(file ?? joinPath(pkg.dir, 'package.json') ?? 'package.json');
  }

  private packageEntry(pkg: NpmPackage, subpath: string, depth = 0): string | null {
    const candidates: string[] = [];
    const key = subpath === '' ? '.' : `./${subpath}`;
    candidates.push(...exportTargets(pkg.exports, key));
    if (subpath === '') {
      for (const field of [pkg.module, pkg.main, pkg.types]) if (field) candidates.push(field);
      candidates.push('src/index', 'index');
    } else {
      candidates.push(subpath, `src/${subpath}`);
    }
    for (const candidate of candidates) {
      const target = joinPath(pkg.dir, candidate);
      if (target === null) continue;
      if (target === pkg.dir && candidate !== 'src/index' && candidate !== 'index') continue;
      const file =
        this.tryFile(target, depth) ?? this.tryFile(buildOutputToSource(target, pkg.dir), depth);
      if (file) return file;
    }
    return null;
  }

  private matchPaths(config: PathsConfig, spec: string): string | null {
    if (!config.paths) return null;
    let best: { prefixLength: number; targets: string[]; star: string } | null = null;
    for (const [pattern, targets] of Object.entries(config.paths)) {
      const star = pattern.indexOf('*');
      if (star === -1) {
        if (pattern === spec && (!best || pattern.length > best.prefixLength)) {
          best = { prefixLength: pattern.length, targets, star: '' };
        }
        continue;
      }
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (
        spec.length >= prefix.length + suffix.length &&
        spec.startsWith(prefix) &&
        spec.endsWith(suffix) &&
        (!best || prefix.length > best.prefixLength)
      ) {
        best = {
          prefixLength: prefix.length,
          targets,
          star: spec.slice(prefix.length, spec.length - suffix.length),
        };
      }
    }
    if (!best) return null;
    for (const target of best.targets) {
      const path = joinPath(config.pathsDir, target.replace('*', best.star));
      const file = path === null ? null : this.tryFile(path);
      if (file) return file;
    }
    return null;
  }

  /** Nearest `tsconfig.json` / `jsconfig.json` at or above `dir`, with `extends` applied. */
  private configFor(dir: string): PathsConfig {
    const cached = this.configForDir.get(dir);
    if (cached) return cached;
    let found: PathsConfig = EMPTY_CONFIG;
    for (const candidate of ancestors(dir)) {
      const prefix = candidate === '' ? '' : `${candidate}/`;
      const path = [`${prefix}tsconfig.json`, `${prefix}jsconfig.json`].find((p) =>
        this.configs.has(p),
      );
      if (path) {
        found = this.loadConfig(path, 0) ?? EMPTY_CONFIG;
        break;
      }
    }
    this.configForDir.set(dir, found);
    return found;
  }

  private loadConfig(path: string, depth: number): PathsConfig | null {
    if (this.loadedConfigs.has(path)) return this.loadedConfigs.get(path) ?? null;
    if (depth > 8) return null; // `extends` cycles
    this.loadedConfigs.set(path, null);
    const text = this.configs.get(path);
    if (text === undefined) return null;

    let json: Record<string, unknown>;
    try {
      json = record(parseJsonc(text));
    } catch {
      return null;
    }
    const configDir = dirname(path);
    const result: PathsConfig = { ...EMPTY_CONFIG, pathsDir: configDir };

    const parents = Array.isArray(json.extends) ? json.extends : [json.extends];
    for (const parent of parents) {
      if (typeof parent !== 'string' || !parent.startsWith('.')) continue; // package presets
      const resolved = joinPath(configDir, parent);
      if (resolved === null) continue;
      const parentPath = this.configs.has(resolved) ? resolved : `${resolved}.json`;
      const inherited = this.loadConfig(parentPath, depth + 1);
      if (!inherited) continue;
      // TypeScript 5 merges an `extends` array left to right: later parents override per option.
      if (inherited.baseUrlDir !== null) result.baseUrlDir = inherited.baseUrlDir;
      if (inherited.paths) {
        result.paths = inherited.paths;
        result.pathsDir = inherited.pathsDir;
      }
    }

    const options = record(json.compilerOptions);
    if (typeof options.baseUrl === 'string') {
      result.baseUrlDir = joinPath(configDir, options.baseUrl);
    }
    const paths = validPaths(options.paths);
    if (paths) {
      result.paths = paths;
      result.pathsDir = result.baseUrlDir ?? configDir;
    } else if (typeof options.baseUrl === 'string' && result.paths) {
      result.pathsDir = result.baseUrlDir ?? result.pathsDir;
    }
    this.loadedConfigs.set(path, result);
    return result;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `compilerOptions.paths` from an untrusted file: keeps only `pattern → string[]` entries, so a
 * malformed config (e.g. a deliberately broken test fixture) can't crash resolution.
 */
function validPaths(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const paths: Record<string, string[]> = {};
  // Real configs have a handful of aliases with one or two targets each.
  for (const [pattern, targets] of Object.entries(value).slice(0, MAX_PATTERNS)) {
    if (!Array.isArray(targets)) continue;
    const strings = targets
      .filter((t): t is string => typeof t === 'string')
      .slice(0, MAX_ALTERNATIVES);
    if (strings.length > 0) paths[pattern] = strings;
  }
  return paths;
}

/** `@scope/name/sub` → `@scope/name`; `lodash/fp` → `lodash`; aliases like `@/x` → null. */
export function packageName(spec: string): string | null {
  if (spec.startsWith('@')) {
    const match = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)/i.exec(spec);
    return match ? (match[1] as string) : null;
  }
  const match = /^([a-z0-9][\w.-]*)/i.exec(spec);
  if (!match || spec.startsWith('~') || spec.startsWith('#')) return null;
  return match[1] as string;
}

/** Candidate files for an `exports` key, preferring source-like conditions. */
function exportTargets(exportsField: unknown, key: string, depth = 0): string[] {
  if (exportsField === null || exportsField === undefined || depth > MAX_EXPORTS_DEPTH) return [];
  if (typeof exportsField === 'string') return key === '.' ? [exportsField] : [];
  if (Array.isArray(exportsField)) {
    return exportsField.slice(0, MAX_ALTERNATIVES).flatMap((e) => exportTargets(e, key, depth + 1));
  }
  if (typeof exportsField !== 'object') return [];

  const entries = exportsField as Record<string, unknown>;
  const isSubpathMap = Object.keys(entries).some((k) => k.startsWith('.'));
  if (!isSubpathMap) return key === '.' ? conditionTargets(entries) : [];

  if (Object.hasOwn(entries, key)) return conditionTargets(entries[key]);
  for (const [pattern, value] of Object.entries(entries).slice(0, MAX_PATTERNS)) {
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      const match = key.slice(prefix.length, key.length - suffix.length);
      return conditionTargets(value).map((t) => t.replace('*', match));
    }
  }
  return [];
}

const CONDITION_ORDER = [
  'source',
  'development',
  'types',
  'import',
  'module',
  'default',
  'require',
  'node',
];

/**
 * Real `exports` maps are a few levels deep with a few conditions. Untrusted manifests can nest
 * thousands of levels (stack overflow) or list thousands of patterns (quadratic work); both are cut.
 */
const MAX_EXPORTS_DEPTH = 16;
const MAX_ALTERNATIVES = 16;
const MAX_PATTERNS = 256;

function conditionTargets(value: unknown, depth = 0): string[] {
  if (depth > MAX_EXPORTS_DEPTH) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ALTERNATIVES).flatMap((v) => conditionTargets(v, depth + 1));
  }
  if (!value || typeof value !== 'object') return [];
  const conditions = value as Record<string, unknown>;
  const ordered = [
    ...CONDITION_ORDER.filter((c) => c in conditions),
    ...Object.keys(conditions).filter((c) => !CONDITION_ORDER.includes(c)),
  ];
  return ordered
    .slice(0, MAX_ALTERNATIVES)
    .flatMap((c) => conditionTargets(conditions[c], depth + 1));
}

/** `pkg/dist/index.d.ts` → `pkg/src/index`: build output is never indexed, its source usually is. */
function buildOutputToSource(path: string, packageDir: string): string {
  const prefix = packageDir === '' ? '' : `${packageDir}/`;
  const inner = path.slice(prefix.length);
  const mapped = inner
    .replace(/^(dist|build|lib|out|esm|cjs)\//, 'src/')
    .replace(/\.d\.[cm]?ts$/, '')
    .replace(/\.[cm]?js$/, '');
  return prefix + (basename(mapped) === '' ? `${mapped}index` : mapped);
}
