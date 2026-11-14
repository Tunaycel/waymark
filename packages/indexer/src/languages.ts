import type { FileKind } from './types.ts';

const BY_EXTENSION: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  py: 'Python',
  pyi: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  scala: 'Scala',
  swift: 'Swift',
  m: 'Objective-C',
  mm: 'Objective-C',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  hh: 'C++',
  cs: 'C#',
  fs: 'F#',
  rb: 'Ruby',
  php: 'PHP',
  dart: 'Dart',
  ex: 'Elixir',
  exs: 'Elixir',
  erl: 'Erlang',
  hs: 'Haskell',
  lua: 'Lua',
  r: 'R',
  jl: 'Julia',
  zig: 'Zig',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ps1: 'PowerShell',
  sql: 'SQL',
  graphql: 'GraphQL',
  gql: 'GraphQL',
  proto: 'Protocol Buffers',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'SCSS',
  less: 'Less',
  html: 'HTML',
  htm: 'HTML',
  md: 'Markdown',
  mdx: 'MDX',
  json: 'JSON',
  jsonc: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  tf: 'Terraform',
  sol: 'Solidity',
};

const BY_FILENAME: Record<string, string> = {
  Dockerfile: 'Dockerfile',
  Makefile: 'Makefile',
  Rakefile: 'Ruby',
  Gemfile: 'Ruby',
  Jenkinsfile: 'Groovy',
};

/** Languages whose files are program code (as opposed to data, markup, or config formats). */
const PROGRAMMING = new Set([
  'TypeScript',
  'JavaScript',
  'Vue',
  'Svelte',
  'Astro',
  'Python',
  'Go',
  'Rust',
  'Java',
  'Kotlin',
  'Scala',
  'Swift',
  'Objective-C',
  'C',
  'C++',
  'C#',
  'F#',
  'Ruby',
  'PHP',
  'Dart',
  'Elixir',
  'Erlang',
  'Haskell',
  'Lua',
  'R',
  'Julia',
  'Zig',
  'Shell',
  'PowerShell',
  'SQL',
  'GraphQL',
  'Protocol Buffers',
  'CSS',
  'SCSS',
  'Less',
  'HTML',
  'Solidity',
  'Terraform',
  'Groovy',
]);

const ASSET_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'svg',
  'bmp',
  'tiff',
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'webm',
  'mov',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'pdf',
  'zip',
  'gz',
  'tgz',
  'jar',
  'wasm',
]);

const DOC_EXTENSIONS = new Set(['md', 'mdx', 'rst', 'adoc', 'txt']);

const CONFIG_FILENAMES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'Dockerfile',
  'Makefile',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'poetry.lock',
  'uv.lock',
  'requirements.txt',
]);

const CONFIG_EXTENSIONS = new Set(['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'env']);

export function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function detectLanguage(path: string): string | null {
  const name = basename(path);
  if (name.endsWith('.d.ts')) return 'TypeScript';
  return BY_FILENAME[name] ?? BY_EXTENSION[extensionOf(path)] ?? null;
}

export function isProgrammingLanguage(language: string | null): boolean {
  return language !== null && PROGRAMMING.has(language);
}

const TEST_PATTERNS = [
  /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|testdata|fixtures)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /(^|\/)conftest\.py$/,
];

export function classify(path: string, language: string | null): FileKind {
  const name = basename(path);
  const ext = extensionOf(path);
  if (ASSET_EXTENSIONS.has(ext)) return 'asset';
  if (CONFIG_FILENAMES.has(name) || /^\.[\w.-]+rc(\.\w+)?$/.test(name)) return 'config';
  if (/(^|\/)\.github\//.test(path) || /\.config\.[cm]?[jt]s$/.test(name)) return 'config';
  if (isProgrammingLanguage(language)) {
    return TEST_PATTERNS.some((p) => p.test(path)) ? 'test' : 'source';
  }
  if (DOC_EXTENSIONS.has(ext) || /^(README|CHANGELOG|LICENSE|CONTRIBUTING)/i.test(name)) {
    return 'docs';
  }
  if (CONFIG_EXTENSIONS.has(ext)) return 'config';
  return 'other';
}

/** Directories that never describe the project itself: dependencies, build output, caches. */
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'bower_components',
  'jspm_packages',
  '.pnpm-store',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.nyc_output',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.venv',
  'venv',
  '.eggs',
  'site-packages',
  // Vendored third-party code (Go modules, PHP Composer, bundled JS libraries).
  'vendor',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  'Pods',
  'DerivedData',
]);

const IGNORED_FILE_PATTERNS = [/\.min\.(js|css)$/, /\.map$/, /\.pyc$/, /(^|\/)\.DS_Store$/];

/** True when a path should be left out of the index entirely. */
export function isIgnoredPath(path: string): boolean {
  const segments = path.split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i] as string;
    if (IGNORED_DIRECTORIES.has(segment) || segment.endsWith('.egg-info')) return true;
  }
  return IGNORED_FILE_PATTERNS.some((p) => p.test(path));
}

/** Whether a directory name should be skipped while walking a tree. */
export function isIgnoredDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name) || name.endsWith('.egg-info');
}

const GENERATED_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',
]);

/** Lockfiles and similar machine-written files: listed, but kept out of line counts. */
export function isGenerated(path: string): boolean {
  return GENERATED_FILES.has(basename(path)) || /\.generated\.\w+$|\.pb\.go$|_pb2\.py$/.test(path);
}
