import { ancestors, joinPath } from './resolve/paths.ts';

/** Directories that only group other units; the unit is one level deeper (`src/auth`, `apps/web`). */
const CONTAINERS = new Set([
  'src',
  'lib',
  'app',
  'apps',
  'packages',
  'pkg',
  'internal',
  'cmd',
  'services',
  'modules',
  'libs',
  'crates',
  'plugins',
]);

/** Manifests under these directories are test data, not real packages. */
const NOT_A_PACKAGE = /(^|\/)(fixtures?|__fixtures__|testdata|test-data|__mocks__)(\/|$)/;

export const ROOT_MODULE = '(root)';

/**
 * Assigns every file to a map node before topic grouping (Phase 1b) refines it:
 *
 * - in a monorepo (manifests below the root), each package is a node: `packages/db`;
 * - otherwise the first meaningful directory is: `src/auth/login.ts` → `src/auth`.
 */
export function createModuleAssigner(manifestDirs: string[]): (path: string) => string {
  const packageRoots = new Set(manifestDirs.filter((d) => d !== '' && !NOT_A_PACKAGE.test(d)));

  return (path: string) => {
    if (packageRoots.size > 0) {
      const slash = path.lastIndexOf('/');
      const dir = slash === -1 ? '' : path.slice(0, slash);
      for (const candidate of ancestors(dir)) {
        if (candidate !== '' && packageRoots.has(candidate)) return candidate;
      }
    }
    const segments = path.split('/');
    if (segments.length === 1) return ROOT_MODULE;
    const first = segments[0] as string;
    if (CONTAINERS.has(first) && segments.length > 2) {
      return joinPath(first, segments[1] as string) ?? first;
    }
    return first;
  };
}
