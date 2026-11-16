import type { Constellation } from '@waymark/db';
import { type Heat, heatOf } from './format';

/**
 * Places every project as a cluster of stars for the 3D overview. Pure and deterministic: the same
 * data always draws the same sky, so a project keeps its place between visits.
 *
 * - A project's stars fill a ball whose volume grows with its topic count; the largest topics sit
 *   at the core, and linked topics are pulled a little towards each other.
 * - Clusters are placed outward along a golden-angle spiral (most recently pushed first, at the
 *   centre) at the first spot where they overlap no earlier cluster.
 */

export interface OverviewProject {
  id: string;
  fullName: string;
  commits7d: number;
  topicCount: number;
  constellation: Constellation;
}

export interface PlacedStar {
  position: [number, number, number];
  /** World-space diameter of the glow. */
  size: number;
  heat: Heat;
}

export interface PlacedProject {
  id: string;
  fullName: string;
  commits7d: number;
  topicCount: number;
  hidden: number;
  center: [number, number, number];
  radius: number;
  stars: PlacedStar[];
  /** Pairs of indexes into `stars`. */
  links: [number, number][];
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const GAP = 3;
/** Link pull iterations: enough to show structure, few enough to keep the ball round. */
const RELAX_STEPS = 24;
/** Spiral steps searched back from the last placement. */
const SPIRAL_LOOKBACK = 64;

export function clusterRadius(stars: number): number {
  return 2.2 + 1.15 * Math.cbrt(Math.max(1, stars));
}

export function starSize(lines: number): number {
  const safe = Number.isFinite(lines) ? Math.max(0, lines) : 0;
  return 0.35 + 0.32 * Math.log10(10 + safe);
}

/** Evenly spread unit directions (Fibonacci sphere). */
function direction(i: number, n: number): [number, number, number] {
  const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN_ANGLE * i;
  return [Math.cos(theta) * r, y, Math.sin(theta) * r];
}

function placeStars(c: Constellation, radius: number, now: number) {
  const n = c.stars.length;
  // Stars arrive largest first: rank k sits at the radius that keeps density even.
  const pos = c.stars.map((_, k) => {
    const [dx, dy, dz] = direction(k, n);
    // A small empty core: dozens of stars stacked on the centre would add up to one white blot.
    const r = n === 1 ? 0 : radius * 0.85 * (0.14 + 0.86 * Math.cbrt((k + 1) / n));
    return [dx * r, dy * r, dz * r] as [number, number, number];
  });
  // A->B and B->A are one line: drawn twice it would glow double and pull twice as hard.
  const seen = new Set<string>();
  const links = c.links.filter((l) => {
    if (l[0] === l[1] || pos[l[0]] === undefined || pos[l[1]] === undefined) return false;
    const key = l[0] < l[1] ? `${l[0]}:${l[1]}` : `${l[1]}:${l[0]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const degree = new Array<number>(n).fill(0);
  for (const l of links) {
    degree[l[0]] = (degree[l[0]] ?? 0) + 1;
    degree[l[1]] = (degree[l[1]] ?? 0) + 1;
  }
  // Springs with a rest length, not to zero: linked stars gather near each other without
  // collapsing onto a hub that imports everything; a hub moves less the more links it has.
  const rest = radius * 0.3;
  for (let step = 0; step < RELAX_STEPS; step++) {
    for (const l of links) {
      const a = pos[l[0]] as [number, number, number];
      const b = pos[l[1]] as [number, number, number];
      const dist = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (dist <= rest || dist === 0) continue;
      const k = (0.04 * (dist - rest)) / dist;
      const ka = k / (degree[l[0]] ?? 1);
      const kb = k / (degree[l[1]] ?? 1);
      for (let d = 0; d < 3; d++) {
        const diff = (b[d] as number) - (a[d] as number);
        a[d] = (a[d] as number) + diff * ka;
        b[d] = (b[d] as number) - diff * kb;
      }
    }
    // Keep everyone inside the ball.
    for (const p of pos) {
      const len = Math.hypot(...p);
      if (len > radius) for (let d = 0; d < 3; d++) p[d] = ((p[d] as number) * radius) / len;
    }
  }
  const stars: PlacedStar[] = c.stars.map((s, k) => ({
    position: pos[k] as [number, number, number],
    size: starSize(s.lines),
    heat: heatOf(s.lastChangedAt, now),
  }));
  return { stars, links };
}

export function layoutConstellations(
  projects: OverviewProject[],
  now: number = Date.now(),
): PlacedProject[] {
  const placed: PlacedProject[] = [];
  // Clusters move outward as they are placed; the search resumes a little before the last spot
  // (smaller clusters can still fill a gap) instead of walking the whole spiral each time, which
  // was seconds for 500 projects.
  let lastStep = 0;
  for (const project of projects) {
    const radius = clusterRadius(project.constellation.stars.length);
    let center: [number, number, number] = [0, 0, 0];
    // Walk the spiral until this cluster touches no earlier one.
    for (let step = Math.max(0, lastStep - SPIRAL_LOOKBACK); placed.length > 0; step++) {
      const angle = step * GOLDEN_ANGLE;
      const dist = 4 * Math.sqrt(step + 1);
      // A gentle vertical wave so the sky isn't a flat disc.
      center = [Math.cos(angle) * dist, Math.sin(step * 1.7) * 2.5, Math.sin(angle) * dist];
      const clear = placed.every(
        (p) =>
          Math.hypot(p.center[0] - center[0], p.center[1] - center[1], p.center[2] - center[2]) >=
          p.radius + radius + GAP,
      );
      if (clear) {
        lastStep = step;
        break;
      }
    }
    const { stars, links } = placeStars(project.constellation, radius, now);
    placed.push({
      id: project.id,
      fullName: project.fullName,
      commits7d: project.commits7d,
      topicCount: project.topicCount,
      hidden: project.constellation.hidden,
      center,
      radius,
      stars,
      links,
    });
  }
  return placed;
}

/** Centre and radius of a sphere around every cluster, for framing the camera. */
export function bounds(projects: PlacedProject[]): {
  center: [number, number, number];
  radius: number;
} {
  if (projects.length === 0) return { center: [0, 0, 0], radius: 10 };
  const c: [number, number, number] = [0, 0, 0];
  for (const p of projects)
    for (let d = 0; d < 3; d++) c[d] = (c[d] as number) + (p.center[d] as number) / projects.length;
  let radius = 0;
  for (const p of projects) {
    radius = Math.max(
      radius,
      Math.hypot(p.center[0] - c[0], p.center[1] - c[1], p.center[2] - c[2]) + p.radius,
    );
  }
  return { center: c, radius };
}
