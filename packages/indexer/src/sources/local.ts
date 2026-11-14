import { execFile } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isIgnoredDirectory } from '../languages.ts';
import { DEFAULT_LIMITS, type SourceFile } from '../types.ts';

const run = promisify(execFile);

/** Files tracked or addable in a git checkout, honouring .gitignore. `null` if not a git repo. */
async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await run(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { maxBuffer: 256 * 1024 * 1024, windowsHide: true },
    );
    return [...new Set(stdout.split('\0').filter(Boolean))].sort();
  } catch {
    return null;
  }
}

async function walk(root: string, dir = ''): Promise<string[]> {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    // Symlinks are skipped: they can point outside the repository or form cycles.
    if (entry.isDirectory()) {
      if (!isIgnoredDirectory(entry.name)) files.push(...(await walk(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Streams the files of a directory on disk. In a git checkout the file list comes from
 * `git ls-files`, so ignored files (build output, secrets in `.env`) are never read.
 */
export async function* localSource(
  root: string,
  { maxFileBytes = DEFAULT_LIMITS.maxFileBytes }: { maxFileBytes?: number } = {},
): AsyncGenerator<SourceFile> {
  const paths = (await gitFiles(root)) ?? (await walk(root));
  for (const path of paths) {
    const absolute = join(root, path);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(absolute);
    } catch {
      continue; // deleted from the working tree but still in the index
    }
    if (!stats.isFile()) continue;
    const size = Number(stats.size);
    const content = size <= maxFileBytes ? new Uint8Array(await readFile(absolute)) : null;
    yield { path, size, content };
  }
}
