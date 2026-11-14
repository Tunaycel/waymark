/** A file handed to the indexer by a source (local checkout, GitHub tarball, …). */
export interface SourceFile {
  /** POSIX path relative to the repository root, e.g. `src/app.ts`. */
  path: string;
  size: number;
  /** File bytes, or `null` when the source skipped reading it (over `maxFileBytes`). */
  content: Uint8Array | null;
}

/** A source that may stop early on its own limits (e.g. an archive size cap). */
export interface TruncatableSource extends AsyncIterable<SourceFile> {
  /** Set once iteration has ended early; read it after iterating. */
  readonly truncated: boolean;
}

export interface IndexLimits {
  /** Files above this size are listed but not read (no imports, lines, or hash). */
  maxFileBytes: number;
  /** Indexing stops after this many files and the result is marked `truncated`. */
  maxFiles: number;
  /** Indexing stops after reading this many bytes in total and is marked `truncated`. */
  maxTotalBytes: number;
  /** At most this many TODO/FIXME markers are kept. */
  maxMarkers: number;
}

export const DEFAULT_LIMITS: IndexLimits = {
  maxFileBytes: 1024 * 1024,
  maxFiles: 100_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxMarkers: 1_000,
};

export type FileKind = 'source' | 'test' | 'config' | 'docs' | 'asset' | 'other';

export interface IndexedFile {
  path: string;
  language: string | null;
  kind: FileKind;
  /** Map node the file belongs to (package root or top-level area). */
  module: string;
  size: number;
  /** `null` when the file was binary or not read. */
  lines: number | null;
  /** Git blob SHA-1 of the content: equal to GitHub's tree SHA, so unchanged files are cheap to detect. */
  blobSha: string | null;
}

export interface FileEdge {
  from: string;
  to: string;
}

export interface ModuleSummary {
  id: string;
  files: number;
  lines: number;
  /** Lines of code per language inside the module. */
  languages: Record<string, number>;
}

export interface ModuleEdge {
  from: string;
  to: string;
  /** Number of file-level imports crossing from `from` to `to`. */
  weight: number;
}

export type Ecosystem = 'npm' | 'pypi' | 'go' | 'cargo';

export interface ExternalDependency {
  name: string;
  ecosystem: Ecosystem;
  /** Files that import it. */
  importedBy: number;
  /** Declared in a manifest (package.json, pyproject.toml, go.mod, Cargo.toml). */
  declared: boolean;
}

export interface Manifest {
  path: string;
  ecosystem: Ecosystem;
  name: string | null;
  dependencies: string[];
  devDependencies: string[];
  scripts: string[];
}

export type MarkerKind = 'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'BUG';

export interface Marker {
  path: string;
  line: number;
  kind: MarkerKind;
  text: string;
}

export interface IndexStats {
  /** Files seen, including skipped ones. */
  files: number;
  /** Files whose content was analysed. */
  analysedFiles: number;
  bytes: number;
  lines: number;
  languages: Record<string, { files: number; lines: number }>;
  imports: {
    total: number;
    internal: number;
    external: number;
    builtin: number;
    /** Imports of build output or vendored code (`./dist/x`), which is never indexed. */
    ignored: number;
    /** Relative / aliased imports that point inside the repo but matched no file. */
    unresolved: number;
  };
  /** True when a limit stopped indexing early. */
  truncated: boolean;
  /** More markers were found than `maxMarkers`; the first ones by path and line are kept. */
  markersTruncated: boolean;
  durationMs: number;
}

export interface RepoIndex {
  files: IndexedFile[];
  edges: FileEdge[];
  modules: ModuleSummary[];
  moduleEdges: ModuleEdge[];
  externalDependencies: ExternalDependency[];
  manifests: Manifest[];
  frameworks: string[];
  markers: Marker[];
  /** Up to 50 unresolved internal-looking imports, for diagnosing resolver gaps. */
  unresolvedSamples: { from: string; specifier: string }[];
  stats: IndexStats;
}

/** An import as written in source, before resolution. */
export interface RawImport {
  specifier: string;
  line: number;
  /** Python `from x import a, b`: the imported names, which may themselves be submodules. */
  names?: string[];
}

export interface Comment {
  text: string;
  line: number;
}

export interface ScanResult {
  imports: RawImport[];
  comments: Comment[];
}
