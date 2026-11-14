import type { Comment, RawImport, ScanResult } from '../types.ts';

/**
 * Finds `import a.b` / `from .x import y` statements in Python source.
 *
 * Strings (including triple-quoted docstrings and prefixed literals like `rb'...'`) and comments are
 * blanked first, so an `import` mentioned inside a docstring never becomes an edge. Line breaks are
 * preserved, so reported line numbers match the file.
 */
function blank(src: string): { code: string; comments: Comment[] } {
  const out: string[] = [];
  const comments: Comment[] = [];
  let line = 1;
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i] as string;
    if (c === '\n') {
      out.push(c);
      line++;
      i++;
      continue;
    }
    if (c === '#') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      comments.push({ text: src.slice(i + 1, stop), line });
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      const triple = src.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      i += quote.length;
      out.push('""');
      while (i < n) {
        const ch = src[i] as string;
        if (ch === '\\') {
          if (src[i + 1] === '\n') {
            out.push('\n');
            line++;
          }
          i += 2;
          continue;
        }
        if (src.startsWith(quote, i)) {
          i += quote.length;
          break;
        }
        if (ch === '\n') {
          if (!triple) break; // unterminated single-line string: recover at the line break
          out.push('\n');
          line++;
        }
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return { code: out.join(''), comments };
}

const IMPORT = /^import\s+(.+)$/;
const FROM_IMPORT = /^from\s+(\.+[\w.]*|[A-Za-z_][\w.]*)\s+import\s+(.+)$/;
const NAME = /^[A-Za-z_][\w.]*$/;

/** An import list in parentheses longer than this is not an import list. */
const MAX_JOINED_LINES = 200;

const parens = (line: string) => {
  let open = 0;
  for (const ch of line) {
    if (ch === '(') open++;
    else if (ch === ')') open--;
  }
  return open;
};

export function scanPython(source: string): ScanResult {
  const { code, comments } = blank(source.replace(/\r\n?/g, '\n'));
  const imports: RawImport[] = [];
  const lines = code.split('\n');

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const first = lines[index] as string;
    if (!first.includes('import')) continue;

    // Join explicit continuations and parenthesised import lists into one logical line, but only
    // for import statements, and only so far: an unbalanced `(` must not swallow the file.
    const parts = [first];
    if (/^\s*(from|import)\b/.test(first)) {
      let open = parens(first);
      let last = first;
      while (
        (last.endsWith('\\') || open > 0) &&
        index + 1 < lines.length &&
        parts.length < MAX_JOINED_LINES
      ) {
        index++;
        last = lines[index] as string;
        parts.push(last);
        open += parens(last);
      }
    }
    const text = parts.map((p) => p.replace(/\\$/, '')).join(' ');

    for (const statement of text.split(';')) {
      const s = statement.trim();
      const from = FROM_IMPORT.exec(s);
      if (from) {
        const names = (from[2] as string)
          .replace(/[()]/g, '')
          .split(',')
          .map(
            (part) =>
              part
                .trim()
                .split(/\s+as\s+/)[0]
                ?.trim() ?? '',
          )
          .filter((name) => NAME.test(name));
        imports.push({ specifier: from[1] as string, line: lineNumber, names });
        continue;
      }
      const plain = IMPORT.exec(s);
      if (plain) {
        for (const part of (plain[1] as string).split(',')) {
          const name =
            part
              .trim()
              .split(/\s+as\s+/)[0]
              ?.trim() ?? '';
          if (NAME.test(name)) imports.push({ specifier: name, line: lineNumber });
        }
      }
    }
  }
  return { imports, comments };
}
