import { dirname } from '../languages.ts';
import type { RawImport } from '../types.ts';
import { BUILTIN, external, internal, joinPath, type Resolution, UNRESOLVED } from './paths.ts';

/** Top-level standard library modules (CPython 3.13 `sys.stdlib_module_names`, common subset). */
const STDLIB = new Set(
  `__future__ _thread abc aifc argparse array ast asyncio atexit base64 bdb binascii bisect builtins
  bz2 calendar cgi cgitb cmath cmd code codecs codeop collections colorsys compileall concurrent
  configparser contextlib contextvars copy copyreg cProfile csv ctypes curses dataclasses datetime dbm
  decimal difflib dis doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput
  fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq
  hmac html http idlelib imaplib importlib inspect io ipaddress itertools json keyword linecache locale
  logging lzma mailbox marshal math mimetypes mmap modulefinder msvcrt multiprocessing netrc numbers
  operator optparse os pathlib pdb pickle pickletools pkgutil platform plistlib poplib posix pprint
  profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline reprlib resource
  rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket
  socketserver sqlite3 ssl stat statistics string stringprep struct subprocess symtable sys sysconfig
  syslog tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token tokenize
  tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv
  warnings wave weakref webbrowser winreg winsound wsgiref xml xmlrpc zipapp zipfile zipimport zlib
  zoneinfo distutils imp asynchat asyncore smtpd typing_extensions`.split(/\s+/),
);

/** Import name → distribution name, where they differ, so manifest matching works. */
const DISTRIBUTION_FOR: Record<string, string> = {
  yaml: 'pyyaml',
  PIL: 'pillow',
  cv2: 'opencv-python',
  sklearn: 'scikit-learn',
  bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil',
  dotenv: 'python-dotenv',
  jwt: 'pyjwt',
  attr: 'attrs',
  OpenSSL: 'pyopenssl',
  Crypto: 'pycryptodome',
  serial: 'pyserial',
  magic: 'python-magic',
  docx: 'python-docx',
  pptx: 'python-pptx',
  fitz: 'pymupdf',
  google: 'google',
  telegram: 'python-telegram-bot',
  multipart: 'python-multipart',
};

/** Normalised distribution name (PEP 503): lower-case, runs of `-_.` collapse to `-`. */
export function normalizeDistribution(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

const MAX_SEGMENTS = 32;

export class PythonResolver {
  private readonly files: ReadonlySet<string>;
  /** Project directories, deepest first. */
  private readonly projectDirs: string[];
  private readonly rootsCache = new Map<string, string[]>();

  /**
   * @param projectDirs directories holding pyproject.toml / setup.py. A file imports from its own
   * (nearest) project first: in a monorepo where every service has an `app/` package,
   * `from app import db` must stay inside the importing service. Sibling projects come last.
   */
  constructor(files: ReadonlySet<string>, projectDirs: string[]) {
    this.files = files;
    this.projectDirs = [...new Set(projectDirs)].sort((a, b) => b.length - a.length);
  }

  /** Import roots for a file: its project and that project's `src/`, the repo root and `src/`, then the file's own directory (scripts run directly). */
  private rootsFor(fromFile: string): string[] {
    const dir = dirname(fromFile);
    const cached = this.rootsCache.get(dir);
    if (cached) return cached;
    const project = this.projectDirs.find((p) => p === '' || dir === p || dir.startsWith(`${p}/`));
    const roots = new Set<string>();
    if (project !== undefined && project !== '') {
      roots.add(project);
      roots.add(`${project}/src`);
    }
    roots.add('');
    roots.add('src');
    roots.add(dir);
    // Last: sibling projects. Workspace members (uv, Poetry) import each other by package name,
    // but only after the file's own project had its chance.
    for (const other of this.projectDirs) {
      if (other === '' || other === project) continue;
      roots.add(other);
      roots.add(`${other}/src`);
    }
    const result = [...roots];
    this.rootsCache.set(dir, result);
    return result;
  }

  /** Resolves one import statement; `from x import a, b` may resolve to several submodules. */
  resolve(fromFile: string, raw: RawImport): Resolution[] {
    const spec = raw.specifier;
    const names = raw.names ?? [];
    // Real module paths have a handful of segments; deeper ones only cost quadratic work.
    if (spec.split('.').length > MAX_SEGMENTS) return [UNRESOLVED];

    if (spec.startsWith('.')) {
      const level = /^\.+/.exec(spec)?.[0].length ?? 1;
      let base: string | null = dirname(fromFile);
      for (let k = 1; k < level && base !== null; k++) base = joinPath(base, '..');
      if (base === null) return [UNRESOLVED];
      const rest = spec.slice(level);
      const moduleDir = rest === '' ? base : joinPath(base, rest.replaceAll('.', '/'));
      if (moduleDir === null) return [UNRESOLVED];
      return this.withNames(moduleDir, names, rest === '');
    }

    for (const root of this.rootsFor(fromFile)) {
      const dir = joinPath(root, spec.replaceAll('.', '/'));
      if (dir === null) continue;
      const resolved = this.withNames(dir, names, false);
      if (resolved.some((r) => r.kind === 'internal')) return resolved;
      // `import a.b.c` where only `a/b.py` exists: `c` is an attribute.
      const segments = spec.split('.');
      for (let k = segments.length - 1; k > 0; k--) {
        const prefix = joinPath(root, segments.slice(0, k).join('/'));
        const file = prefix === null ? null : this.moduleFile(prefix);
        if (file) return [internal(file)];
      }
    }

    const top = spec.split('.')[0] as string;
    if (STDLIB.has(top)) return [BUILTIN];
    return [external(normalizeDistribution(DISTRIBUTION_FOR[top] ?? top))];
  }

  /**
   * `from pkg import a, b`: each name may be a submodule (`pkg/a.py`) or an attribute of `pkg`.
   * For `from . import a`, `pkg` is only a fallback when a name isn't a submodule.
   */
  private withNames(moduleDir: string, names: string[], packageOnly: boolean): Resolution[] {
    const results: Resolution[] = [];
    let needsModule = names.length === 0;
    for (const name of names) {
      if (name === '*') {
        needsModule = true;
        continue;
      }
      const sub = this.moduleFile(`${moduleDir}/${name}`);
      if (sub) results.push(internal(sub));
      else needsModule = true;
    }
    if (needsModule) {
      const own = packageOnly ? this.packageInit(moduleDir) : this.moduleFile(moduleDir);
      results.push(own ? internal(own) : UNRESOLVED);
    }
    return results;
  }

  private moduleFile(path: string): string | null {
    for (const candidate of [`${path}.py`, `${path}.pyi`, `${path}/__init__.py`]) {
      if (this.files.has(candidate)) return candidate;
    }
    return null;
  }

  private packageInit(dir: string): string | null {
    const init = dir === '' ? '__init__.py' : `${dir}/__init__.py`;
    return this.files.has(init) ? init : null;
  }
}
