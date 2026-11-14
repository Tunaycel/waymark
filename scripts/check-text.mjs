/**
 * Fails when a tracked text file contains characters that render invisibly or reorder text:
 * NUL and other C0 controls (except tab/newline/CR), DEL, zero-width characters, bidirectional
 * overrides and isolates ("Trojan Source"), word joiners, and byte-order marks. Code that needs
 * such characters builds them with String.fromCharCode.
 *
 *   pnpm check:text
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql|ya?ml|toml|txt)$|(^|\/)\.[\w.-]+$/;
const ranges = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];
const bad = new RegExp(
  `[${ranges.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`,
);

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && TEXT.test(f));

const problems = [];
for (const file of files) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const match = bad.exec(line);
      if (match) {
        const code = match[0].codePointAt(0)?.toString(16).padStart(4, '0');
        problems.push(`${file}:${i + 1}: invisible or control character U+${code}`);
      }
    });
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`checked ${files.length} files: no invisible or control characters`);
