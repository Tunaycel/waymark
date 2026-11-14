/**
 * Names a file exposes: exported functions, classes, and types. They are the cheapest strong signal
 * of what a file is about ("createSession", "StripeWebhook"), and they let topic naming work from
 * structure instead of sending source code anywhere.
 */

/** Per file: enough to characterise it, bounded so a generated file can't flood the index. */
export const MAX_SYMBOLS_PER_FILE = 30;
const MAX_SYMBOL_LENGTH = 64;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export class SymbolCollector {
  private readonly seen = new Set<string>();
  readonly symbols: string[] = [];

  add(name: string | null | undefined): void {
    if (!name || this.symbols.length >= MAX_SYMBOLS_PER_FILE) return;
    if (name.length > MAX_SYMBOL_LENGTH || !IDENTIFIER.test(name) || this.seen.has(name)) return;
    this.seen.add(name);
    this.symbols.push(name);
  }

  get full(): boolean {
    return this.symbols.length >= MAX_SYMBOLS_PER_FILE;
  }
}

const PY_DEF = /^(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)|^class[ \t]+([A-Za-z_]\w*)/;

/** Top-level `def`/`class` names of Python code whose strings and comments are already blanked. */
export function pythonSymbols(lines: string[]): string[] {
  const out = new SymbolCollector();
  for (const line of lines) {
    if (out.full) break;
    // Only column 0: nested functions and methods are implementation detail.
    const match = PY_DEF.exec(line);
    const name = match?.[1] ?? match?.[2];
    if (name && !name.startsWith('_')) out.add(name);
  }
  return out.symbols;
}

/** Exported Go identifiers start with an upper-case letter. */
export const isGoExported = (name: string) => /^[A-Z]/.test(name);
