/**
 * Regression tests for defects found in review: hostile or unusual repository content must never
 * crash indexing, stall the worker, or silently lose data.
 */
import { describe, expect, it } from 'vitest';
import { indexRepository } from './indexer.ts';
import { scanGo } from './lexers/go.ts';
import { scanComponent, scanJavaScript } from './lexers/js.ts';
import { scanPython } from './lexers/python.ts';
import { parseManifest } from './manifests.ts';
import { markersFromComments, markersFromLines } from './markers.ts';
import { JsResolver } from './resolve/js.ts';
import { DEFAULT_LIMITS, type SourceFile } from './types.ts';

const encoder = new TextEncoder();
async function* memory(files: Record<string, string>): AsyncGenerator<SourceFile> {
  for (const [path, text] of Object.entries(files)) {
    const content = encoder.encode(text);
    yield { path, size: content.byteLength, content };
  }
}

/** Fails if `fn` takes longer than `ms`: these inputs used to take seconds to hours. */
function fast<T>(ms: number, fn: () => T): T {
  const started = performance.now();
  const result = fn();
  expect(performance.now() - started).toBeLessThan(ms);
  return result;
}

describe('pathological input stays linear', () => {
  it('a line full of unterminated regex-looking slashes (was 32 s for 100 KB)', () => {
    const src = `x=(${"'/[".repeat(300_000)}\nimport ok from './ok';`;
    const result = fast(1_500, () => scanJavaScript(src));
    expect(result.imports.map((i) => i.specifier)).toEqual(['./ok']);
  });

  it('a component with tens of thousands of script blocks (was 32 s)', () => {
    const src = '<script>import a from "./a";</script>\n'.repeat(20_000);
    const result = fast(2_000, () => scanComponent(src));
    expect(result.imports).toHaveLength(20_000);
    expect(result.imports.at(-1)?.line).toBe(20_000);
  });

  it('an unclosed <script> does not rescan the rest of the file for every opening', () => {
    const src = '<script '.repeat(100_000);
    expect(fast(1_000, () => scanComponent(src)).imports).toEqual([]);
  });

  it('a Python file with an unbalanced parenthesis keeps later imports (were all lost)', () => {
    const src = `from x import (\n${'    a,\n'.repeat(20_000)}import after\n`;
    const result = fast(1_500, () => scanPython(src));
    expect(result.imports.map((i) => i.specifier)).toContain('after');

    const broken = `print((\n${'y = 1\n'.repeat(20_000)}import later\n`;
    expect(fast(1_500, () => scanPython(broken)).imports.map((i) => i.specifier)).toEqual([
      'later',
    ]);
  });

  it('a line with thousands of markers', () => {
    const line = `// ${'TODO '.repeat(100_000)}\r`;
    const markers = fast(1_000, () => markersFromLines('a.rb', line));
    expect(markers).toHaveLength(1);
  });
});

describe('CRLF files (Windows checkouts)', () => {
  it('finds markers in every language path', () => {
    expect(scanJavaScript('// TODO: refactor\r\nconst a = 1;\r\n').comments[0]?.text).toContain(
      'TODO',
    );
    expect(
      markersFromComments('a.ts', scanJavaScript('// TODO: refactor\r\n').comments)[0]?.text,
    ).toBe('refactor');
    expect(markersFromComments('a.py', scanPython('# FIXME: later\r\n').comments)[0]?.text).toBe(
      'later',
    );
    expect(markersFromLines('a.rb', '# HACK: x\r\n')[0]?.text).toBe('x');
  });

  it('finds Python imports', () => {
    expect(scanPython('import os\r\nfrom .a import (\r\n  b,\r\n)\r\n').imports).toEqual([
      { specifier: 'os', line: 1 },
      { specifier: '.a', line: 2, names: ['b'] },
    ]);
  });
});

describe('untrusted text', () => {
  it('cuts long marker text at a code point, never inside an emoji', () => {
    const [marker] = markersFromComments('a.ts', [
      { text: ` TODO: ${'x'.repeat(199)}🚀 later`, line: 1 },
    ]);
    expect(marker?.text.isWellFormed()).toBe(true);
    expect(Array.from(marker?.text ?? '')).toHaveLength(200);
  });

  it('skips paths longer than 1,200 UTF-8 bytes, counting multi-byte characters', async () => {
    const cjk = `${'字'.repeat(500)}.ts`; // 500 chars, 1,503 bytes
    const index = await indexRepository(memory({ [cjk]: '', 'ok.ts': '' }));
    expect(index.files.map((f) => f.path)).toEqual(['ok.ts']);
  });
});

describe('malformed configuration never fails a run', () => {
  it.each([
    ['null target list', '{ "compilerOptions": { "paths": { "@x": null } } }'],
    ['non-string targets', '{ "compilerOptions": { "paths": { "@x/*": [1, {}] } } }'],
    ['paths as an array', '{ "compilerOptions": { "paths": ["nope"] } }'],
    ['compilerOptions as a string', '{ "compilerOptions": "strict" }'],
    ['a JSON string', '"tsconfig"'],
  ])('tsconfig with %s', async (_name, config) => {
    const index = await indexRepository(
      memory({
        'tsconfig.json': config,
        'src/a.ts': "import x from '@x';\nimport y from '@x/y';\nimport z from './z';",
        'src/z.ts': '',
      }),
    );
    expect(index.edges).toEqual([{ from: 'src/a.ts', to: 'src/z.ts' }]);
  });

  it('merges an `extends` array option by option, later parents winning', () => {
    const r = new JsResolver({
      files: new Set(['lib/x.ts', 'web/src/y.ts']),
      packages: [],
      configs: new Map([
        ['tsconfig.paths.json', '{ "compilerOptions": { "paths": { "@lib/*": ["lib/*"] } } }'],
        ['tsconfig.strict.json', '{ "compilerOptions": { "strict": true } }'],
        [
          'web/tsconfig.json',
          '{ "extends": ["../tsconfig.paths.json", "../tsconfig.strict.json"] }',
        ],
      ]),
    });
    expect(r.resolve('web/src/y.ts', '@lib/x')).toEqual({ kind: 'internal', path: 'lib/x.ts' });
  });
});

describe('Python monorepos', () => {
  it('resolves `from app import db` inside the importing service, not a sibling', async () => {
    const index = await indexRepository(
      memory({
        'svc-a/pyproject.toml': '[project]\nname = "a"\n',
        'svc-a/app/__init__.py': '',
        'svc-a/app/db.py': '',
        'svc-a/app/main.py': 'from app import db\n',
        'svc-b/pyproject.toml': '[project]\nname = "b"\n',
        'svc-b/app/__init__.py': '',
        'svc-b/app/db.py': '',
        'svc-b/app/main.py': 'from app import db\n',
      }),
    );
    expect(index.edges).toEqual([
      { from: 'svc-a/app/main.py', to: 'svc-a/app/db.py' },
      { from: 'svc-b/app/main.py', to: 'svc-b/app/db.py' },
    ]);
  });

  it('resolves sibling modules of a script that is run directly', async () => {
    const index = await indexRepository(
      memory({ 'tools/run.py': 'import helpers\n', 'tools/helpers.py': '' }),
    );
    expect(index.edges).toEqual([{ from: 'tools/run.py', to: 'tools/helpers.py' }]);
  });
});

describe('break-it pass: performance cliffs', () => {
  it('Go: an unclosed import group does not re-collect every later string (was OOM)', () => {
    const src = `package x\n${'import ( "a" '.repeat(80_000)}`;
    const result = fast(1_500, () => scanGo(src));
    expect(result.imports.length).toBeLessThanOrEqual(5_000);
  });

  it('go.mod made of blank lines or unclosed require blocks parses in linear time', () => {
    expect(fast(1_000, () => parseManifest('go.mod', '\n'.repeat(1_000_000)))?.goModule).toBe(
      undefined,
    );
    expect(
      fast(1_000, () => parseManifest('go.mod', 'module m\n'.concat('require (\n'.repeat(100_000))))
        ?.goModule,
    ).toBe('m');
  });

  it('Python: absurdly deep dotted imports are not resolved quadratically', async () => {
    const src = `import ${Array.from({ length: 16_000 }, () => 'a').join('.')}\n`;
    const started = performance.now();
    await indexRepository(memory({ 'x.py': src, 'a/__init__.py': '' }));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('Go: many modules with many requires resolve quickly', async () => {
    const files: Record<string, string> = {};
    for (let m = 0; m < 30; m++) {
      files[`staging/m${m}/go.mod`] =
        `module example.com/m${m}\n\nrequire (\n${Array.from({ length: 150 }, (_, r) => `\tgithub.com/dep${r}/x v1.0.0`).join('\n')}\n)\n`;
      for (let f = 0; f < 100; f++) {
        files[`staging/m${m}/pkg${f}/f.go`] =
          `package p\nimport (\n${Array.from({ length: 6 }, (_, r) => `\t"github.com/dep${r}/x/sub"`).join('\n')}\n)\n`;
      }
    }
    const started = performance.now();
    const index = await indexRepository(memory(files));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(index.externalDependencies[0]).toMatchObject({
      name: 'github.com/dep0/x',
      declared: true,
    });
  });

  it('package.json `exports` nested thousands of levels deep cannot crash the run', async () => {
    // Built as text: JSON.stringify itself overflows at this depth, JSON.parse does not.
    const exportsField = `${'{"import":'.repeat(20_000)}"./index.js"${'}'.repeat(20_000)}`;
    const index = await indexRepository(
      memory({
        'p/package.json': `{"name":"p","exports":${exportsField}}`,
        'p/index.js': '',
        'a.js': "import p from 'p';",
      }),
    );
    // Too deep to follow: resolution falls back to the package's conventional entry.
    expect(index.edges).toEqual([{ from: 'a.js', to: 'p/index.js' }]);
  });
});

describe('break-it pass: one odd construct must not hide the rest of a file', () => {
  const specs = (src: string) => scanJavaScript(src).imports.map((i) => i.specifier);

  it('a regex right after an `if (...)` condition', () => {
    expect(specs("if (x) /`/.test(y);\nimport a from './a';")).toEqual(['./a']);
    expect(specs("if (ok) /^/*/.test(s);\nimport b from './b';")).toEqual(['./b']);
  });

  it('a division after a call is still a division', () => {
    expect(specs("const r = f(a) / 2 / g(b);\nimport c from './c';")).toEqual(['./c']);
  });

  it('JSX text containing an unclosed `/*` or a lone backtick', () => {
    expect(specs("const el = <p>use src/*.ts</p>;\nimport d from './d';")).toEqual(['./d']);
    expect(specs("const el = <code>`</code>;\nimport e from './e';")).toEqual(['./e']);
  });

  it('a <script> inside an HTML comment of a component is ignored', () => {
    const src = "<!-- <script>import z from 'z'</script> -->\n<script>import y from './y'</script>";
    expect(scanComponent(src).imports.map((i) => i.specifier)).toEqual(['./y']);
  });
});

describe('break-it pass: monorepos and determinism', () => {
  it('Python workspace members still import each other', async () => {
    const index = await indexRepository(
      memory({
        'libs/l0/pyproject.toml': '[project]\nname = "l0"\n',
        'libs/l0/src/l0/__init__.py': '',
        'libs/l0/src/l0/m0.py': 'from l1.m1 import x\n',
        'libs/l1/pyproject.toml': '[project]\nname = "l1"\n',
        'libs/l1/src/l1/__init__.py': '',
        'libs/l1/src/l1/m1.py': 'x = 1\n',
      }),
    );
    expect(index.edges).toEqual([{ from: 'libs/l0/src/l0/m0.py', to: 'libs/l1/src/l1/m1.py' }]);
  });

  it('produces byte-identical JSON for any input order', async () => {
    const files: Record<string, string> = {
      'a/package.json': '{"name":"dup","main":"a.js"}',
      'a/a.js': '',
      'b/package.json': '{"name":"dup","main":"b.js"}',
      'b/b.js': '',
      'x.ts': "import d from 'dup'; // TODO one",
      'y.py': '# TODO two\nimport os',
      'z.go': 'package z // TODO three',
      'w.css': 'a {}',
    };
    const entries = Object.entries(files);
    const outputs = new Set<string>();
    for (let round = 0; round < 10; round++) {
      const shuffled = [...entries].sort(() => Math.random() - 0.5);
      const index = await indexRepository(memory(Object.fromEntries(shuffled)), {
        ...DEFAULT_LIMITS,
        maxMarkers: 2,
      });
      outputs.add(JSON.stringify({ ...index, stats: { ...index.stats, durationMs: 0 } }));
    }
    expect(outputs.size).toBe(1);
    const index = JSON.parse([...outputs][0] as string);
    expect(index.edges).toEqual([{ from: 'x.ts', to: 'a/a.js' }]);
    expect(index.markers.map((m: { path: string }) => m.path)).toEqual(['x.ts', 'y.py']);
    expect(index.stats.markersTruncated).toBe(true);
  });
});
