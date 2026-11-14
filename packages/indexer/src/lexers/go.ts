import type { Comment, RawImport, ScanResult } from '../types.ts';

type Token = { kind: 'id' | 'str' | 'punc'; value: string; line: number };

/** Real files import dozens of packages; anything beyond this is not a real import list. */
const MAX_IMPORTS = 5_000;

/** Finds `import "x"` and `import ( a "x"; "y" )` declarations, skipping comments and strings. */
export function scanGo(src: string): ScanResult {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  let line = 1;
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i] as string;
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      comments.push({ text: src.slice(i + 2, stop), line });
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end;
      src
        .slice(i + 2, stop)
        .split('\n')
        .forEach((text, k) => {
          comments.push({ text, line: line + k });
        });
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = line;
      let value = '';
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          value += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
      i++;
      tokens.push({ kind: 'str', value, line: start });
      continue;
    }
    if (c === '`') {
      const start = line;
      const end = src.indexOf('`', i + 1);
      const stop = end === -1 ? n : end;
      const value = src.slice(i + 1, stop);
      for (const ch of value) if (ch === '\n') line++;
      i = stop + 1;
      tokens.push({ kind: 'str', value, line: start });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < n && /\w/.test(src[i] as string)) i++;
      tokens.push({ kind: 'id', value: src.slice(start, i), line });
      continue;
    }
    tokens.push({ kind: 'punc', value: c, line });
    i++;
  }

  const imports: RawImport[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k] as Token;
    if (t.kind !== 'id' || t.value !== 'import') continue;
    const next = tokens[k + 1];
    if (imports.length >= MAX_IMPORTS) break;
    if (next?.kind === 'punc' && next.value === '(') {
      // A group ends at `)`. An unclosed group must not re-collect every later string once per
      // `import` keyword (quadratic time and output), so it also ends at the next `import`.
      let j = k + 2;
      for (; j < tokens.length; j++) {
        const s = tokens[j] as Token;
        if (s.kind === 'punc' && s.value === ')') break;
        if (s.kind === 'id' && s.value === 'import') break;
        if (s.kind === 'str') imports.push({ specifier: s.value, line: s.line });
      }
      k = j - 1;
      continue;
    }
    // `import "x"`, `import alias "x"`, `import . "x"`, `import _ "x"`
    const spec = next?.kind === 'str' ? next : tokens[k + 2];
    if (spec?.kind === 'str') imports.push({ specifier: spec.value, line: spec.line });
  }
  return { imports, comments };
}
