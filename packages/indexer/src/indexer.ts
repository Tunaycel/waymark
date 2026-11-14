import { createHash } from 'node:crypto';
import {
  basename,
  classify,
  detectLanguage,
  dirname,
  isGenerated,
  isIgnoredPath,
} from './languages.ts';
import { scanGo } from './lexers/go.ts';
import { scanComponent, scanJavaScript } from './lexers/js.ts';
import { scanPython } from './lexers/python.ts';
import {
  detectFrameworks,
  isManifestPath,
  MANIFEST_FILES,
  type NpmPackage,
  type ParsedManifest,
  parseManifest,
} from './manifests.ts';
import { markersFromComments, markersFromLines } from './markers.ts';
import { createModuleAssigner } from './modules.ts';
import { type GoModule, GoResolver } from './resolve/go.ts';
import { JsResolver } from './resolve/js.ts';
import type { Resolution } from './resolve/paths.ts';
import { normalizeDistribution, PythonResolver } from './resolve/python.ts';
import {
  DEFAULT_LIMITS,
  type Ecosystem,
  type ExternalDependency,
  type FileEdge,
  type IndexedFile,
  type IndexLimits,
  type Marker,
  type ModuleEdge,
  type ModuleSummary,
  type RawImport,
  type RepoIndex,
  type SourceFile,
  type TruncatableSource,
} from './types.ts';

type Family = 'js' | 'python' | 'go';

const FAMILY_BY_LANGUAGE: Record<string, Family> = {
  TypeScript: 'js',
  JavaScript: 'js',
  Vue: 'js',
  Svelte: 'js',
  Astro: 'js',
  Python: 'python',
  Go: 'go',
};

const ECOSYSTEM: Record<Family, Ecosystem> = { js: 'npm', python: 'pypi', go: 'go' };

const MARKERS_PER_FILE = 100;
const MARKER_COLLECTION_LIMIT = 50_000;

const TS_CONFIG = /^(tsconfig|jsconfig)([\w.-]*)\.json$/;
const BINARY_SNIFF_BYTES = 8_000;

/**
 * Longer paths (in UTF-8 bytes) are skipped. Postgres B-tree keys max out at ~2.7 kB, and an edge's
 * key holds two paths: 2 x 1,200 bytes plus the snapshot id stays below that.
 */
const MAX_PATH_BYTES = 1_200;
const utf8 = new TextEncoder();

/**
 * Makes a source path repository-relative and POSIX. Returns `null` for paths that are absolute,
 * try to leave the repository (`..`), or are absurdly long: those are never indexed.
 */
export function normalizeRepoPath(path: string): string | null {
  const posix = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (posix.length > MAX_PATH_BYTES || utf8.encode(posix).byteLength > MAX_PATH_BYTES) return null;
  if (posix === '' || posix.startsWith('/') || /^[a-z]:/i.test(posix) || posix.includes('\0')) {
    return null;
  }
  const segments = posix.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return null;
  return posix;
}

/** Git's blob id: SHA-1 over `blob <size>\0<content>`. Matches the SHAs in GitHub's tree API. */
export function gitBlobSha(content: Uint8Array): string {
  return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
}

function isBinary(content: Uint8Array): boolean {
  const end = Math.min(content.byteLength, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (content[i] === 0) return true;
  return false;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.endsWith('\n') ? lines - 1 : lines;
}

interface Pending {
  file: IndexedFile;
  family: Family | null;
  imports: RawImport[];
}

/**
 * Builds the structural index of a repository: files, languages, the import graph between files
 * and modules, external dependencies, manifests, frameworks, and TODO/FIXME markers.
 *
 * Content is analysed as files stream past and then dropped, so memory stays proportional to the
 * number of files, not their size.
 */
export async function indexRepository(
  source: AsyncIterable<SourceFile>,
  limits: IndexLimits = DEFAULT_LIMITS,
): Promise<RepoIndex> {
  const started = performance.now();
  const pending: Pending[] = [];
  const seen = new Set<string>();
  const manifests: ParsedManifest[] = [];
  const configs = new Map<string, string>();
  const markers: Marker[] = [];
  const languages: Record<string, { files: number; lines: number }> = {};
  let bytes = 0;
  let totalLines = 0;
  let analysedFiles = 0;
  let truncated = false;
  let pythonProjectDirs: string[] = [];

  let entries = 0;
  for await (const entry of source) {
    // Ignored, duplicate, or invalid entries don't count as files, but they still cost work.
    if (++entries > limits.maxFiles * 4) {
      truncated = true;
      break;
    }
    const path = normalizeRepoPath(entry.path);
    if (path === null || isIgnoredPath(path) || seen.has(path)) continue;
    if (seen.size >= limits.maxFiles) {
      truncated = true;
      break;
    }
    seen.add(path);

    const language = detectLanguage(path);
    const file: IndexedFile = {
      path,
      language,
      kind: classify(path, language),
      module: '',
      size: entry.size,
      lines: null,
      blobSha: null,
    };
    const item: Pending = {
      file,
      family: language ? (FAMILY_BY_LANGUAGE[language] ?? null) : null,
      imports: [],
    };
    pending.push(item);

    const content = entry.content;
    if (content === null || content.byteLength > limits.maxFileBytes) continue;
    if (bytes + content.byteLength > limits.maxTotalBytes) {
      truncated = true;
      continue;
    }
    bytes += content.byteLength;
    file.blobSha = gitBlobSha(content);
    if (isBinary(content)) continue;

    analysedFiles++;
    const text = new TextDecoder().decode(content);
    file.lines = countLines(text);
    if (language && !isGenerated(path)) {
      const stat = languages[language] ?? { files: 0, lines: 0 };
      stat.files++;
      stat.lines += file.lines;
      languages[language] = stat;
      totalLines += file.lines;
    }

    const name = basename(path);
    if (isManifestPath(path)) {
      const parsed = parseManifest(path, text);
      if (parsed) manifests.push(parsed);
      if (name === 'pyproject.toml') pythonProjectDirs.push(dirname(path));
    }
    if (name === 'setup.py') pythonProjectDirs.push(dirname(path));
    if (TS_CONFIG.test(name)) configs.set(path, text);

    let scan: { imports: RawImport[]; comments: { text: string; line: number }[] } | null = null;
    if (language === 'TypeScript' || language === 'JavaScript') scan = scanJavaScript(text);
    else if (language === 'Vue' || language === 'Svelte' || language === 'Astro') {
      scan = scanComponent(text);
    } else if (language === 'Python') scan = scanPython(text);
    else if (language === 'Go') scan = scanGo(text);

    if (scan) {
      item.imports = scan.imports;
    }
    // Markers are collected with generous bounds, then sorted and cut, so which ones are kept
    // doesn't depend on the order files arrive in.
    if (markers.length < MARKER_COLLECTION_LIMIT) {
      const found = scan
        ? markersFromComments(path, scan.comments)
        : file.kind === 'source' || file.kind === 'test' || file.kind === 'config'
          ? markersFromLines(path, text)
          : [];
      for (const marker of found.slice(0, MARKERS_PER_FILE)) markers.push(marker);
    }
  }

  if ((source as Partial<TruncatableSource>).truncated === true) truncated = true;

  const files = new Set(pending.map((p) => p.file.path));
  pythonProjectDirs = [...new Set(pythonProjectDirs)];
  const npmPackages = manifests.map((m) => m.npm).filter((p): p is NpmPackage => !!p);
  const goModules: GoModule[] = manifests
    .filter((m) => m.goModule)
    .map((m) => ({
      dir: dirname(m.manifest.path),
      path: m.goModule as string,
      requires: m.manifest.dependencies,
    }));

  const js = new JsResolver({ files, packages: npmPackages, configs });
  const python = new PythonResolver(files, pythonProjectDirs);
  const go = new GoResolver(files, goModules);

  // Package roots: every directory with a real manifest (requirements.txt files don't count).
  const assignModule = createModuleAssigner([
    ...manifests
      .filter((m) => MANIFEST_FILES.has(basename(m.manifest.path)))
      .map((m) => dirname(m.manifest.path)),
    ...pythonProjectDirs,
  ]);

  const edgeKeys = new Set<string>();
  const edges: FileEdge[] = [];
  const externalUsers = new Map<
    string,
    { ecosystem: Ecosystem; name: string; files: Set<string> }
  >();
  const importStats = {
    total: 0,
    internal: 0,
    external: 0,
    builtin: 0,
    ignored: 0,
    unresolved: 0,
  };
  const unresolvedSamples: { from: string; specifier: string }[] = [];

  for (const { file, family, imports } of pending) {
    file.module = assignModule(file.path);
    if (!family) continue;
    for (const raw of imports) {
      let resolutions: Resolution[];
      try {
        resolutions =
          family === 'js'
            ? [js.resolve(file.path, raw.specifier)]
            : family === 'python'
              ? python.resolve(file.path, raw)
              : [go.resolve(raw.specifier)];
      } catch {
        // Resolution reads untrusted config files. A case nobody anticipated costs one edge,
        // never the whole index.
        resolutions = [{ kind: 'unresolved' }];
      }

      for (const r of resolutions) {
        importStats.total++;
        if (r.kind === 'internal') {
          importStats.internal++;
          const key = `${file.path}\0${r.path}`;
          if (r.path !== file.path && !edgeKeys.has(key)) {
            edgeKeys.add(key);
            edges.push({ from: file.path, to: r.path });
          }
        } else if (r.kind === 'external') {
          importStats.external++;
          const ecosystem = ECOSYSTEM[family];
          const key = `${ecosystem}\0${r.name}`;
          const users = externalUsers.get(key) ?? { ecosystem, name: r.name, files: new Set() };
          users.files.add(file.path);
          externalUsers.set(key, users);
        } else if (r.kind === 'builtin') {
          importStats.builtin++;
        } else if (r.kind === 'ignored') {
          importStats.ignored++;
        } else {
          importStats.unresolved++;
          if (unresolvedSamples.length < 50) {
            unresolvedSamples.push({ from: file.path, specifier: raw.specifier });
          }
        }
      }
    }
  }

  const indexedFiles = pending.map((p) => p.file).sort((a, b) => compare(a.path, b.path));
  const moduleOf = new Map(indexedFiles.map((f) => [f.path, f.module]));

  const moduleMap = new Map<string, ModuleSummary>();
  for (const f of indexedFiles) {
    const summary = moduleMap.get(f.module) ?? { id: f.module, files: 0, lines: 0, languages: {} };
    summary.files++;
    if (f.lines !== null && f.language && !isGenerated(f.path)) {
      summary.lines += f.lines;
      summary.languages[f.language] = (summary.languages[f.language] ?? 0) + f.lines;
    }
    moduleMap.set(f.module, summary);
  }

  const moduleWeights = new Map<string, ModuleEdge>();
  for (const edge of edges) {
    const from = moduleOf.get(edge.from) as string;
    const to = moduleOf.get(edge.to) as string;
    if (from === to) continue;
    const key = `${from}\0${to}`;
    const existing = moduleWeights.get(key) ?? { from, to, weight: 0 };
    existing.weight++;
    moduleWeights.set(key, existing);
  }

  const parsedManifests = manifests.map((m) => m.manifest).sort((a, b) => compare(a.path, b.path));
  const declared = new Set<string>();
  for (const m of parsedManifests) {
    for (const dep of [...m.dependencies, ...m.devDependencies]) {
      declared.add(`${m.ecosystem}\0${m.ecosystem === 'pypi' ? normalizeDistribution(dep) : dep}`);
    }
  }
  const externalDependencies: ExternalDependency[] = [...externalUsers.entries()]
    .map(([key, u]) => ({
      name: u.name,
      ecosystem: u.ecosystem,
      importedBy: u.files.size,
      declared: declared.has(key),
    }))
    .sort((a, b) => b.importedBy - a.importedBy || compare(a.name, b.name));

  markers.sort((a, b) => compare(a.path, b.path) || a.line - b.line);
  const markersTruncated = markers.length > limits.maxMarkers;

  return {
    files: indexedFiles,
    edges: edges.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to)),
    modules: [...moduleMap.values()].sort((a, b) => compare(a.id, b.id)),
    moduleEdges: [...moduleWeights.values()].sort(
      (a, b) => b.weight - a.weight || compare(a.from, b.from) || compare(a.to, b.to),
    ),
    externalDependencies,
    manifests: parsedManifests,
    frameworks: detectFrameworks(parsedManifests),
    markers: markers.slice(0, limits.maxMarkers),
    unresolvedSamples,
    stats: {
      files: indexedFiles.length,
      analysedFiles,
      bytes,
      lines: totalLines,
      languages: Object.fromEntries(Object.entries(languages).sort(([a], [b]) => compare(a, b))),
      markersTruncated,
      imports: importStats,
      truncated,
      durationMs: Math.round(performance.now() - started),
    },
  };
}

/** Locale-independent ordering, so the same repository always produces the same index. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
