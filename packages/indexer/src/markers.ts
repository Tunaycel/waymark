import type { Comment, Marker, MarkerKind } from './types.ts';

// `s` flag: `.` also matches `\r` and other line terminators, so the match can't fail at the end
// and backtrack through every marker on the line (CRLF files lost all markers, and lines with many
// markers were quadratic).
const MARKER = /\b(TODO|FIXME|HACK|XXX|BUG)\b(?:\([^)\n]*\))?[:\s-]*(.*)/s;
const MAX_TEXT = 200;

/** Cuts at a code-point boundary: slicing UTF-16 units can split an emoji into invalid text. */
function truncate(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  return Array.from(text).slice(0, MAX_TEXT).join('');
}

function fromText(path: string, text: string, line: number): Marker | null {
  const match = MARKER.exec(text);
  if (!match) return null;
  // Bound the work first: a marker can sit at the start of a megabyte-long line.
  let body = (match[2] ?? '').slice(0, MAX_TEXT * 4).trim();
  for (const closer of ['*/', '-->']) {
    if (body.endsWith(closer)) body = body.slice(0, -closer.length).trimEnd();
  }
  body = truncate(body);
  return { path, line, kind: match[1] as MarkerKind, text: body };
}

/** Markers found in comments a lexer already extracted (exact: never matches strings or code). */
export function markersFromComments(path: string, comments: Comment[]): Marker[] {
  const markers: Marker[] = [];
  for (const comment of comments) {
    const marker = fromText(path, comment.text, comment.line);
    if (marker) markers.push(marker);
  }
  return markers;
}

/** Line comment openers for languages without a dedicated lexer. */
const COMMENT_START = /(\/\/|#|--|\/\*|^\s*\*|<!--|;;)/;

/** Best-effort markers for other languages: only text after a comment opener is considered. */
export function markersFromLines(path: string, src: string): Marker[] {
  const markers: Marker[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] as string;
    if (!/TODO|FIXME|HACK|XXX|BUG/.test(text)) continue;
    const opener = COMMENT_START.exec(text);
    if (!opener) continue;
    const marker = fromText(path, text.slice((opener.index ?? 0) + opener[0].length), i + 1);
    if (marker) markers.push(marker);
  }
  return markers;
}
