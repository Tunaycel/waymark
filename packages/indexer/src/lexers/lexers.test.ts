import { describe, expect, it } from 'vitest';
import { scanGo } from './go.ts';
import { scanComponent, scanJavaScript } from './js.ts';
import { scanPython } from './python.ts';

const specs = (src: string) => scanJavaScript(src).imports.map((i) => i.specifier);

describe('scanJavaScript', () => {
  it('finds every static import and re-export form', () => {
    const src = `
      import a from './a';
      import * as b from "./b";
      import { c, d as e } from './c';
      import f, { g } from './f';
      import type { T } from './types';
      import './side-effect.css';
      export * from './reexport';
      export { h } from './h';
      export type { U } from './u';
      export * as ns from './ns';
      import {
        multi,
        line,
      } from './multiline';
    `;
    expect(specs(src)).toEqual([
      './a',
      './b',
      './c',
      './f',
      './types',
      './side-effect.css',
      './reexport',
      './h',
      './u',
      './ns',
      './multiline',
    ]);
  });

  it('finds require() and dynamic import() with static strings only', () => {
    const src = `
      const x = require('x');
      const y = await import('./y');
      const z = import(\`./z\`);
      const dyn = import(\`./pages/\${name}\`);
      const notStatic = require(name);
      import a = require('ts-equals');
    `;
    expect(specs(src)).toEqual(['x', './y', './z', 'ts-equals']);
  });

  it('ignores imports inside comments, strings, and templates', () => {
    const src = `
      // import a from './commented';
      /* import b from './block'
         require('./also-block') */
      const s = "import c from './in-string'";
      const t = \`require('./in-template') \${ "import('./in-expr-string')" }\`;
      import real from './real';
    `;
    expect(specs(src)).toEqual(['./real']);
  });

  it('is not confused by regular expressions containing quotes or comment openers', () => {
    const src = `
      const re = /['"]\\/\\/*/g;
      const re2 = /[/*]/;
      const ratio = a / b / c;
      if (/^import/.test(x)) {}
      import after from './after-regex';
    `;
    expect(specs(src)).toEqual(['./after-regex']);
  });

  it('handles nested template literals', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the template source is the test input.
    const src = 'const t = `a ${`b ${c} d`} e`;\nimport z from "./z";';
    expect(specs(src)).toEqual(['./z']);
  });

  it('ignores member access named import/require and import.meta', () => {
    const src = `
      obj.import('./no');
      obj.require('./no');
      const url = import.meta.url;
      foo?.require('./no');
    `;
    expect(specs(src)).toEqual([]);
  });

  it('does not treat `export const` or a later statement as a re-export', () => {
    const src = `
      export { local };
      const from = 'x';
      export const value = 1;
    `;
    expect(specs(src)).toEqual([]);
  });

  it('recovers from an unterminated string (e.g. JSX text) at the line break', () => {
    const src = `
      const el = <p>Don't stop</p>;
      import ok from './ok';
    `;
    expect(specs(src)).toEqual(['./ok']);
  });

  it('reports line numbers and collects comments for markers', () => {
    const result = scanJavaScript('// TODO: first\n\nimport a from "./a"; /* FIXME two\nlines */');
    expect(result.imports).toEqual([{ specifier: './a', line: 3 }]);
    expect(result.comments).toEqual([
      { text: ' TODO: first', line: 1 },
      { text: ' FIXME two', line: 3 },
      { text: 'lines ', line: 4 },
    ]);
  });

  it('skips a hashbang line', () => {
    expect(specs('#!/usr/bin/env node\nimport x from "./x";')).toEqual(['./x']);
  });
});

describe('scanComponent', () => {
  it('scans Vue/Svelte script blocks with correct line numbers', () => {
    const src = `<template>
  <div>import fake from './template-text'</div>
</template>
<script setup lang="ts">
import Child from './Child.vue';
</script>`;
    expect(scanComponent(src).imports).toEqual([{ specifier: './Child.vue', line: 5 }]);
  });

  it('scans Astro frontmatter', () => {
    const src = `---\nimport Layout from '../layouts/Base.astro';\n---\n<Layout />`;
    expect(scanComponent(src).imports.map((i) => i.specifier)).toEqual(['../layouts/Base.astro']);
  });
});

describe('scanPython', () => {
  it('finds import and from-import statements with names', () => {
    const src = `
import os
import a.b.c as abc, d
from . import sibling
from ..pkg.mod import (
    one,
    two as second,
)
from x import *
if True:
    import nested
import a; import b
`;
    expect(scanPython(src).imports).toEqual([
      { specifier: 'os', line: 2 },
      { specifier: 'a.b.c', line: 3 },
      { specifier: 'd', line: 3 },
      { specifier: '.', line: 4, names: ['sibling'] },
      { specifier: '..pkg.mod', line: 5, names: ['one', 'two'] },
      { specifier: 'x', line: 9, names: [] },
      { specifier: 'nested', line: 11 },
      { specifier: 'a', line: 12 },
      { specifier: 'b', line: 12 },
    ]);
  });

  it('ignores imports in docstrings, strings, and comments', () => {
    const src = `"""
import not_real
"""
x = 'from fake import y'
# import commented
s = rb"""
from bytes import z
"""
import real
`;
    expect(scanPython(src).imports).toEqual([{ specifier: 'real', line: 9 }]);
    expect(scanPython(src).comments).toEqual([{ text: ' import commented', line: 5 }]);
  });

  it('joins backslash continuations', () => {
    expect(scanPython('import a, \\\n    b\n').imports.map((i) => i.specifier)).toEqual(['a', 'b']);
  });
});

describe('scanGo', () => {
  it('finds single and grouped imports with aliases', () => {
    const src = `package main

import "fmt"
import (
	"net/http"
	str "strings"
	_ "github.com/lib/pq"
	. "example.com/dot"
	// "commented/out"
)
import alias "example.com/single"
var s = "import \\"not/an/import\\""
`;
    expect(scanGo(src).imports.map((i) => i.specifier)).toEqual([
      'fmt',
      'net/http',
      'strings',
      'github.com/lib/pq',
      'example.com/dot',
      'example.com/single',
    ]);
  });

  it('handles raw strings containing quotes and comment openers', () => {
    const src = 'package x\nvar q = `"// /*`\nimport "after/raw"\n';
    expect(scanGo(src).imports).toEqual([{ specifier: 'after/raw', line: 3 }]);
  });
});
