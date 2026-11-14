import { basename, dirname } from '../languages.ts';
import { BUILTIN, external, internal, joinPath, type Resolution, UNRESOLVED } from './paths.ts';

/** Import paths deeper than this are not real; don't spend quadratic work on them. */
const MAX_SEGMENTS = 32;

export interface GoModule {
  /** Directory containing go.mod. */
  dir: string;
  /** Module path declared in go.mod. */
  path: string;
  requires: string[];
}

/**
 * Go imports name packages (directories), not files. An edge points to a representative file of
 * the package: the one named after the directory, else `doc.go`, else the first file alphabetically.
 * Module-level edges, which the map is built from, are exact either way.
 */
export class GoResolver {
  private readonly modules: GoModule[];
  private readonly packageFiles = new Map<string, string[]>();
  private readonly representatives = new Map<string, string | null>();
  private readonly requires: Set<string>;

  constructor(files: ReadonlySet<string>, modules: GoModule[]) {
    // Longest module path first, so nested modules win over their parents.
    this.modules = [...modules].sort((a, b) => b.path.length - a.path.length);
    this.requires = new Set(modules.flatMap((m) => m.requires));
    for (const file of files) {
      if (!file.endsWith('.go') || file.endsWith('_test.go')) continue;
      const dir = dirname(file);
      const list = this.packageFiles.get(dir) ?? [];
      list.push(file);
      this.packageFiles.set(dir, list);
    }
  }

  resolve(spec: string): Resolution {
    for (const mod of this.modules) {
      if (spec !== mod.path && !spec.startsWith(`${mod.path}/`)) continue;
      const dir = joinPath(mod.dir, spec.slice(mod.path.length).replace(/^\//, ''));
      const file = dir === null ? null : this.representative(dir);
      return file ? internal(file) : UNRESOLVED;
    }
    const first = spec.split('/')[0] as string;
    if (!first.includes('.')) return BUILTIN; // standard library: no domain in the first element
    // Longest required module path that prefixes the import: walk the import's own prefixes.
    const segments = spec.split('/');
    if (segments.length > MAX_SEGMENTS) return external(segments.slice(0, 3).join('/'));
    for (let k = segments.length; k > 0; k--) {
      const prefix = segments.slice(0, k).join('/');
      if (this.requires.has(prefix)) return external(prefix);
    }
    return external(segments.slice(0, 3).join('/'));
  }

  private representative(dir: string): string | null {
    const cached = this.representatives.get(dir);
    if (cached !== undefined) return cached;
    const files = this.packageFiles.get(dir);
    const chosen = files && files.length > 0 ? pickRepresentative(dir, files) : null;
    this.representatives.set(dir, chosen);
    return chosen;
  }
}

function pickRepresentative(dir: string, files: string[]): string {
  const sorted = [...files].sort();
  const named = `${basename(dir)}.go`;
  return (
    sorted.find((f) => basename(f) === named) ??
    sorted.find((f) => basename(f) === 'doc.go') ??
    (sorted[0] as string)
  );
}
