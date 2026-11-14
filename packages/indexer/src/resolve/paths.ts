/** Repository-relative POSIX path helpers. Paths never start with `/` and never contain `.`/`..`. */

/**
 * Joins `base` (a directory) and `relative`, normalising `.` and `..`.
 * Returns `null` when the result would escape the repository root.
 */
export function joinPath(base: string, relative: string): string | null {
  const parts = base === '' ? [] : base.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

/** `a/b/c` → [`a/b/c`, `a/b`, `a`, ``]: the directory itself and every ancestor up to the root. */
export function ancestors(dir: string): string[] {
  const result = [dir];
  let current = dir;
  while (current !== '') {
    const slash = current.lastIndexOf('/');
    current = slash === -1 ? '' : current.slice(0, slash);
    result.push(current);
  }
  return result;
}

export type Resolution =
  | { kind: 'internal'; path: string }
  | { kind: 'external'; name: string }
  | { kind: 'builtin' }
  /** Points into build output or vendored dependencies, which are never indexed. */
  | { kind: 'ignored' }
  | { kind: 'unresolved' };

export const BUILTIN: Resolution = { kind: 'builtin' };
export const UNRESOLVED: Resolution = { kind: 'unresolved' };
export const IGNORED: Resolution = { kind: 'ignored' };
export const internal = (path: string): Resolution => ({ kind: 'internal', path });
export const external = (name: string): Resolution => ({ kind: 'external', name });
