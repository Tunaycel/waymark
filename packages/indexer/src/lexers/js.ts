import type { Comment, RawImport, ScanResult } from '../types.ts';

/**
 * A small JavaScript/TypeScript tokenizer that knows just enough to find module references
 * reliably: it skips comments, strings, template literals (including nested `${}`), and regular
 * expression literals, so `// import x from 'y'` or `"require('z')"` never produce false edges.
 *
 * It is deliberately error-tolerant. Unterminated strings and regexes end at the line break, so one
 * odd construct (e.g. an apostrophe in JSX text) can only disturb its own line.
 */

type TokenKind = 'id' | 'str' | 'tpl' | 'punc';

interface Token {
  kind: TokenKind;
  /** Identifier name, punctuator, or string value. Templates with `${}` have value `null`. */
  value: string | null;
  line: number;
  /** On `)`: it closed the condition of `if`/`while`/`for`/`with`, so a `/` after it starts a regex. */
  control?: boolean;
}

const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

/** After these keywords a `/` starts a regular expression, not a division. */
const EXPRESSION_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const isIdStart = (c: string) => /[A-Za-z_$ -￿]/.test(c);
const isIdPart = (c: string) => /[\w$ -￿]/.test(c);

function tokenize(src: string, lineOffset: number): { tokens: Token[]; comments: Comment[] } {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  let line = 1 + lineOffset;
  let i = 0;
  const n = src.length;
  // Brace depth at which each open template `${` started; closing it resumes the template.
  const templateStack: number[] = [];
  let braceDepth = 0;
  // Line on which a regex probe already failed. Probing again from every later `/` on that line
  // would make one hostile line quadratic.
  let regexFailedOnLine = -1;
  // Which open parentheses belong to a control statement's condition.
  const parenStack: boolean[] = [];
  // A multi-line construct opened by mistake (JSX text like `a/*b` or a stray backtick) must not
  // swallow the rest of the file. With nothing to close it, it is treated as a single line /
  // a single character instead. Precomputed, so checking stays O(1).
  const lastCommentClose = src.lastIndexOf('*/');
  const lastBacktick = src.lastIndexOf('`');

  const pushComment = (text: string, startLine: number) => {
    text.split('\n').forEach((part, k) => {
      comments.push({ text: part, line: startLine + k });
    });
  };

  /** Scans template characters from `i` until the closing backtick or a `${`. */
  const scanTemplate = (startLine: number, hadExpression: boolean) => {
    let value = '';
    while (i < n) {
      const c = src[i] as string;
      if (c === '\\') {
        value += src.slice(i, i + 2);
        if (src[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        tokens.push({ kind: 'tpl', value: hadExpression ? null : value, line: startLine });
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        templateStack.push(braceDepth);
        braceDepth++;
        // A template with an expression is never a static module specifier.
        if (!hadExpression) tokens.push({ kind: 'tpl', value: null, line: startLine });
        return;
      }
      if (c === '\n') line++;
      value += c;
      i++;
    }
    tokens.push({ kind: 'tpl', value: hadExpression ? null : value, line: startLine });
  };

  const regexAllowed = () => {
    const prev = tokens.at(-1);
    if (!prev) return true;
    if (prev.kind === 'punc') {
      if (prev.value === ')') return prev.control === true; // `if (x) /re/.test(y)`
      return prev.value !== ']';
    }
    if (prev.kind === 'id') return EXPRESSION_KEYWORDS.has(prev.value as string);
    return false;
  };

  // Hashbang line.
  if (src.startsWith('#!')) {
    while (i < n && src[i] !== '\n') i++;
  }

  while (i < n) {
    const c = src[i] as string;

    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') {
      i++;
      continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      pushComment(src.slice(i + 2, stop), line);
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*' && lastCommentClose < i + 2) {
      // Never closed: only this line is a comment.
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      pushComment(src.slice(i + 2, stop), line);
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end;
      const body = src.slice(i + 2, stop);
      pushComment(body, line);
      for (const ch of body) if (ch === '\n') line++;
      i = end === -1 ? n : end + 2;
      continue;
    }

    if (c === "'" || c === '"') {
      const startLine = line;
      let value = '';
      i++;
      while (i < n) {
        const ch = src[i] as string;
        if (ch === '\\') {
          // Line continuation inside a string.
          if (src[i + 1] === '\n') line++;
          value += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (ch === c) {
          i++;
          break;
        }
        if (ch === '\n') break; // unterminated: recover at the line break
        value += ch;
        i++;
      }
      tokens.push({ kind: 'str', value, line: startLine });
      continue;
    }

    if (c === '`' && i < lastBacktick) {
      i++;
      scanTemplate(line, false);
      continue;
    }

    if (isIdStart(c)) {
      const start = i;
      i++;
      while (i < n && isIdPart(src[i] as string)) i++;
      tokens.push({ kind: 'id', value: src.slice(start, i), line });
      continue;
    }

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      i++;
      while (i < n && /[\w.]/.test(src[i] as string)) i++;
      tokens.push({ kind: 'id', value: '0', line }); // numbers behave like operands
      continue;
    }

    if (c === '/' && line !== regexFailedOnLine && regexAllowed()) {
      // Try to read a regex literal; it cannot span lines. If it doesn't close, it was a division.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const ch = src[j] as string;
        if (ch === '\n') break;
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        j++;
        while (j < n && /[a-z]/i.test(src[j] as string)) j++;
        tokens.push({ kind: 'id', value: '0', line }); // a regex is an operand
        i = j;
        continue;
      }
      regexFailedOnLine = line;
    }

    if (c === '(') {
      const prev = tokens.at(-1);
      parenStack.push(prev?.kind === 'id' && CONTROL_KEYWORDS.has(prev.value as string));
    } else if (c === ')') {
      tokens.push({ kind: 'punc', value: ')', line, control: parenStack.pop() === true });
      i++;
      continue;
    }
    if (c === '{') {
      braceDepth++;
    } else if (c === '}') {
      braceDepth--;
      if (templateStack.length > 0 && braceDepth === templateStack.at(-1)) {
        templateStack.pop();
        i++;
        scanTemplate(line, true);
        continue;
      }
    }
    if (c === '?' && src[i + 1] === '.') {
      tokens.push({ kind: 'punc', value: '?.', line });
      i += 2;
      continue;
    }
    tokens.push({ kind: 'punc', value: c, line });
    i++;
  }

  return { tokens, comments };
}

const isPunc = (t: Token | undefined, v: string) => t?.kind === 'punc' && t.value === v;
const isId = (t: Token | undefined, v?: string) =>
  t?.kind === 'id' && (v === undefined || t.value === v);

/** A static string: a plain string or a template literal without `${}`. */
const staticString = (t: Token | undefined): string | null =>
  t && (t.kind === 'str' || t.kind === 'tpl') && t.value !== null ? t.value : null;

/**
 * From `start`, walks an import/export clause (`{ a, b as c }`, `* as ns`, `type X`) and returns the
 * index of a `from` keyword followed by a string, or -1 if the clause is anything else.
 */
function findFrom(tokens: Token[], start: number): number {
  for (let j = start; j < tokens.length && j < start + 2_000; j++) {
    const t = tokens[j];
    if (isId(t, 'from') && staticString(tokens[j + 1]) !== null) return j;
    // A clause never contains another statement, and only `from` may follow its closing brace.
    if (isId(t, 'import') || isId(t, 'export')) return -1;
    if (isPunc(tokens[j - 1], '}') && j > start) return -1;
    const allowed =
      t?.kind === 'id' ||
      isPunc(t, '{') ||
      isPunc(t, '}') ||
      isPunc(t, ',') ||
      isPunc(t, '*') ||
      // `import { "string-name" as x }` (ES2022 arbitrary module namespace names)
      t?.kind === 'str';
    if (!allowed) return -1;
  }
  return -1;
}

function extract(tokens: Token[]): RawImport[] {
  const imports: RawImport[] = [];
  const add = (specifier: string, line: number) => {
    if (specifier.length > 0 && specifier.length <= 1_000) imports.push({ specifier, line });
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind !== 'id') continue;
    const prev = tokens[i - 1];
    // `obj.import`, `obj?.require`: member access, not a keyword.
    if (isPunc(prev, '.') || isPunc(prev, '?.')) continue;
    const next = tokens[i + 1];

    if (t.value === 'import') {
      if (isPunc(next, '(')) {
        const spec = staticString(tokens[i + 2]);
        if (spec !== null && (isPunc(tokens[i + 3], ')') || isPunc(tokens[i + 3], ','))) {
          add(spec, t.line);
        }
        continue;
      }
      if (isPunc(next, '.')) continue; // import.meta
      const direct = staticString(next);
      if (direct !== null && next?.kind === 'str') {
        add(direct, t.line);
        continue;
      }
      const from = findFrom(tokens, i + 1);
      if (from !== -1) add(staticString(tokens[from + 1]) as string, t.line);
      continue;
    }

    if (t.value === 'export') {
      // Re-exports only: `export * from`, `export { a } from`, `export type { T } from`.
      const opener = isId(next, 'type') ? tokens[i + 2] : next;
      if (isPunc(opener, '*') || isPunc(opener, '{')) {
        const from = findFrom(tokens, i + 1);
        if (from !== -1) add(staticString(tokens[from + 1]) as string, t.line);
      }
      continue;
    }

    if (t.value === 'require' && isPunc(next, '(')) {
      const spec = staticString(tokens[i + 2]);
      if (spec !== null && isPunc(tokens[i + 3], ')')) add(spec, t.line);
    }
  }
  return imports;
}

export function scanJavaScript(src: string, lineOffset = 0): ScanResult {
  const { tokens, comments } = tokenize(src, lineOffset);
  return { imports: extract(tokens), comments };
}

/** Vue / Svelte single-file components and Astro pages: scans the embedded script blocks. */
export function scanComponent(src: string): ScanResult {
  const result: ScanResult = { imports: [], comments: [] };
  const merge = (part: ScanResult) => {
    for (const item of part.imports) result.imports.push(item);
    for (const item of part.comments) result.comments.push(item);
  };

  // Astro component script lives in a `---` fenced frontmatter block at the top.
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (frontmatter?.[1] !== undefined) merge(scanJavaScript(frontmatter[1], 1));

  // Linear scan (no backtracking regex): find `<script ...>` … `</script>` pairs, counting line
  // breaks incrementally so many blocks don't each recount from the start of the file.
  const lower = src.toLowerCase();
  let cursor = 0;
  let line = 0;
  let counted = 0;
  let nextComment = lower.indexOf('<!--');
  while (cursor < src.length) {
    const open = lower.indexOf('<script', cursor);
    if (open === -1) break;
    // Inside an HTML comment? Then resume after the comment. (The next comment opening is looked
    // up only when the cursor has passed the previous one, so this stays linear.)
    if (nextComment !== -1 && nextComment < cursor) nextComment = lower.indexOf('<!--', cursor);
    if (nextComment !== -1 && nextComment < open) {
      const commentClose = lower.indexOf('-->', nextComment + 4);
      if (commentClose === -1) break;
      cursor = commentClose + 3;
      continue;
    }
    const tagEnd = src.indexOf('>', open);
    if (tagEnd === -1) break;
    const close = lower.indexOf('</script>', tagEnd + 1);
    if (close === -1) break; // unclosed: nothing after it can be a complete block either
    for (let k = counted; k < tagEnd + 1; k++) if (src.charCodeAt(k) === 10) line++;
    counted = tagEnd + 1;
    merge(scanJavaScript(src.slice(tagEnd + 1, close), line));
    cursor = close + '</script>'.length;
  }
  return result;
}
