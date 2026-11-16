/** "3 min ago", "yesterday", "12 Nov": compact, relative while recent. */
export function timeAgo(iso: string | Date | null, now = Date.now()): string {
  if (!iso) return 'never';
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** 12_345 → "12.3k". */
export function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** How "hot" a topic is, from its last change: drives the glow on the map. */
export type Heat = 'live' | 'warm' | 'cold';
export function heatOf(lastChangedAt: string | null, now = Date.now()): Heat {
  if (!lastChangedAt) return 'cold';
  const age = now - Date.parse(lastChangedAt);
  if (age < 24 * 3_600_000) return 'live';
  if (age < 7 * 24 * 3_600_000) return 'warm';
  return 'cold';
}

export const ROLE_LABELS: Record<string, string> = {
  feature: 'Feature',
  api: 'API',
  ui: 'UI',
  data: 'Data',
  infrastructure: 'Infrastructure',
  integration: 'Integration',
  tooling: 'Tooling',
  tests: 'Tests',
  docs: 'Docs',
  config: 'Config',
  other: 'Other',
};

export const roleColor = (role: string | null) =>
  `var(--role-${role && role in ROLE_LABELS ? role : 'other'})`;
