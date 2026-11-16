/** URL of a repository's map. Each segment is encoded: local names can contain `#`, `?`, or `%`. */
export function mapHref(fullName: string): string {
  return `/r/${fullName.split('/').map(encodeURIComponent).join('/')}`;
}

/** C0 controls and DEL, written as escapes so the source itself stays free of them. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Inverse of `mapHref` for route segments; a malformed escape is kept as typed, never a crash.
 * Null when the name has control characters: no repository is called that, and Postgres rejects NUL.
 */
export function nameFromSegments(segments: string[]): string | null {
  const name = segments
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join('/');
  return CONTROL.test(name) ? null : name;
}
