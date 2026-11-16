'use client';

import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  bounds,
  layoutConstellations,
  type OverviewProject,
  type PlacedProject,
  signalRoutes,
} from '@/lib/constellation';
import { mapHref } from '@/lib/paths';

/**
 * The welcome screen's sky: every project a constellation, every topic a star. Stars changed today
 * glow sky-blue and pulse, this week's glow teal, quiet ones stay dim. Drag to orbit, scroll to
 * zoom; a project's name (a real link, reachable by keyboard) or its cluster opens its map.
 */

// Concrete colours: shaders and WebGL don't resolve CSS variables. They match globals.css.
const HEAT_COLOR = { live: '#38bdf8', warm: '#5eead4', cold: '#8a99b3' } as const;
const HEAT_ALPHA = { live: 1, warm: 0.9, cold: 0.38 } as const;
/** Pointer travel (px) after which a press on a cluster counts as a drag, not a click. */
const CLICK_SLOP = 4;

/*
 * Shared by both point shaders. `uScale` is in device pixels per world unit at distance 1 (the
 * canvas height times the pixel ratio), so a star is the same size on a standard and a Retina
 * screen. Sizes are capped: flying into a cluster must not turn one star into a screen-wide flash.
 */
const POINT_SIZE_CAP = 64;

const STAR_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aPulse;
  uniform float uTime;
  uniform float uScale;
  uniform float uDim;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float pulse = 1.0 + aPulse * 0.25 * sin(uTime * 2.4 + position.x * 3.1 + position.z * 1.7);
    gl_PointSize = min(aSize * pulse * uScale / max(-mv.z, 0.001), ${POINT_SIZE_CAP.toFixed(1)});
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    vAlpha = aAlpha * uDim;
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    // A crisp disc with a short, fast-falling glow: sharp at any zoom, no smeared haze. The
    // edge is antialiased over one screen pixel (fwidth), so it stays smooth without
    // supersampling the whole canvas.
    float edge = max(fwidth(d), 0.02);
    float core = 1.0 - smoothstep(0.11 - edge, 0.11 + edge, d);
    float glow = exp(-d * d * 42.0) * 0.45;
    gl_FragColor = vec4(vColor, (core * 0.9 + glow) * vAlpha);
    // Colours are kept linear; convert to the screen's sRGB like three's own materials do,
    // so a star, its link, and the legend's CSS colour all match.
    #include <colorspace_fragment>
  }
`;

/**
 * Points that run along links: a bright head and a short fading tail. `position` is the link's
 * start (it also gives three the draw count); the tail's spacing is in world units, so a streak
 * has the same length on a short link and a long one.
 */
const SIGNAL_VERTEX = /* glsl */ `
  attribute vec3 aEnd;
  attribute float aLength;
  attribute float aPhase;
  attribute float aSpeed;
  attribute float aTrail;
  attribute vec3 aColor;
  attribute float aBright;
  uniform float uTime;
  uniform float uScale;
  uniform float uDim;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float head = fract(uTime * aSpeed + aPhase);
    float t = head - aTrail * 0.07 / aLength;
    float inside = step(0.0, t);
    t = clamp(t, 0.0, 1.0);
    vec4 mv = modelViewMatrix * vec4(mix(position, aEnd, t), 1.0);
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    // Fades in as it leaves a star and out as it arrives.
    vAlpha = inside * sin(3.14159 * t) * aBright * (1.0 - aTrail * 0.11) * uDim;
    // A tail point that hasn't left the star yet is skipped entirely, not drawn and discarded.
    float size = (0.42 - aTrail * 0.04) * uScale / max(-mv.z, 0.001);
    gl_PointSize = vAlpha > 0.0 ? min(size, ${(POINT_SIZE_CAP / 2).toFixed(1)}) : 0.0;
  }
`;

const SIGNAL_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5 || vAlpha <= 0.0) discard;
    float core = 1.0 - smoothstep(0.12, 0.2, d);
    float glow = exp(-d * d * 30.0) * 0.6;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.55), (core + glow) * vAlpha);
    #include <colorspace_fragment>
  }
`;

/**
 * Seconds handed to the shaders, wrapped: a float32 clock that has run for a day moves in uneven
 * steps (≈8 ms), and after a week signals would jump. Wrapping every 1024 s is invisible.
 */
const shaderTime = (elapsed: number) => elapsed % 1024;

/** Device pixels per world unit at distance 1, for the point shaders. */
const pointScale = (height: number, dpr: number) => height * dpr * 1.13;

/** Per heat: link brightness, signal speed (link lengths per second), and signal brightness. */
const ENERGY = {
  live: { line: 1, speed: 0.55, bright: 1 },
  warm: { line: 0.75, speed: 0.38, bright: 0.85 },
  cold: { line: 0.42, speed: 0.16, bright: 0.5 },
} as const;
/** Points per signal: close together they draw one short, tapering streak. */
const SIGNAL_TRAIL = 8;

export function Observatory({
  projects,
  animate,
}: {
  projects: OverviewProject[];
  /** False for reduced motion: no auto-rotation or pulsing, and frames only on change. */
  animate: boolean;
}) {
  const placed = useMemo(() => layoutConstellations(projects), [projects]);
  const [hovered, setHovered] = useState<string | null>(null);
  const labels = useRef(new Map<string, HTMLAnchorElement>());
  const frame = useMemo(() => bounds(placed), [placed]);

  // Scrolled out of view, the sky draws nothing at all.
  const wrapper = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = wrapper.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) =>
      setVisible(entries.some((e) => e.isIntersecting)),
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={wrapper} className="relative h-full w-full">
      <Canvas
        frameloop={!visible ? 'never' : animate ? 'always' : 'demand'}
        dpr={[1, 2]}
        // No tone mapping: the theme's colours, without a film curve that washes them out.
        flat
        gl={{ antialias: true, alpha: true }}
        camera={{
          fov: 45,
          near: 0.1,
          far: 2000,
          position: [
            frame.center[0],
            frame.center[1] + frame.radius * 0.6,
            frame.center[2] + frame.radius * 2.4,
          ],
        }}
        onPointerMissed={() => setHovered(null)}
        aria-hidden="true"
      >
        <Controls
          target={frame.center}
          radius={frame.radius}
          animate={animate}
          rotate={animate && hovered === null}
        />
        <Dust radius={frame.radius * 3} />
        {placed.map((p) => (
          <Cluster
            key={p.id}
            project={p}
            animate={animate}
            dimmed={hovered !== null && hovered !== p.id}
            highlighted={hovered === p.id}
            onHover={setHovered}
          />
        ))}
        <Labels projects={placed} labels={labels} />
      </Canvas>

      {/* Project names: real links positioned over their clusters each frame. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {placed.map((p) => (
          <Link
            key={p.id}
            ref={(el) => {
              if (el) labels.current.set(p.id, el);
              else labels.current.delete(p.id);
            }}
            href={mapHref(p.fullName)}
            onMouseEnter={() => setHovered(p.id)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(p.id)}
            onBlur={() => setHovered(null)}
            className="pointer-events-auto absolute left-0 top-0 whitespace-nowrap rounded-full border border-line bg-bg/70 px-3 py-1 text-xs text-muted opacity-0 backdrop-blur-md transition-[color,border-color,background-color] hover:border-accent/60 hover:text-text focus-visible:border-accent focus-visible:text-text focus-visible:outline-none data-[active=true]:border-accent/60 data-[active=true]:text-text"
            data-active={hovered === p.id}
          >
            <span className="font-medium">{p.fullName}</span>
            {hovered === p.id && (
              <span className="ml-2 text-faint">
                {p.topicCount} topics
                {p.commits7d > 0 ? ` · ${p.commits7d} commits this week` : ''}
              </span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

function Controls({
  target,
  radius,
  animate,
  rotate,
}: {
  target: [number, number, number];
  radius: number;
  animate: boolean;
  rotate: boolean;
}) {
  const { camera, gl, size, invalidate } = useThree();
  // Created and disposed in the same effect: OrbitControls attaches its listeners in its
  // constructor, so one built in useMemo stays detached after Strict Mode's cleanup and remount.
  const [controls, setControls] = useState<OrbitControls | null>(null);
  const interacted = useRef(false);
  useEffect(() => {
    const c = new OrbitControls(camera, gl.domElement);
    c.enablePan = false;
    c.autoRotateSpeed = 0.35;
    const onStart = () => {
      interacted.current = true;
    };
    // With frameloop "demand" (reduced motion), every camera move asks for one frame.
    const onChange = () => invalidate();
    c.addEventListener('start', onStart);
    c.addEventListener('change', onChange);
    setControls(c);
    return () => {
      c.removeEventListener('start', onStart);
      c.removeEventListener('change', onChange);
      c.dispose();
      setControls(null);
    };
  }, [camera, gl, invalidate]);

  useEffect(() => {
    if (!controls) return;
    controls.target.set(...target);
    // Damping needs a frame on every tick; without animation the camera stops where it is let go.
    controls.enableDamping = animate;
    controls.dampingFactor = 0.08;
    controls.minDistance = Math.max(4, radius * 0.4);
    controls.maxDistance = radius * 6;
    controls.update();
    invalidate();
  }, [controls, target, radius, animate, invalidate]);

  // Frame everything: the limiting field of view is the narrower of the two (phones are tall).
  // Once the viewer has turned or zoomed the sky, a resize keeps their view.
  useEffect(() => {
    if (!controls || interacted.current || size.width < 2 || size.height < 2) return;
    const perspective = camera as THREE.PerspectiveCamera;
    const vFov = THREE.MathUtils.degToRad(perspective.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (size.width / size.height));
    // Clusters lie near one horizontal plane: the bounding sphere overstates their height (0.62
    // fills a wide screen) but not their width, which limits a tall screen (phones need all of it).
    const fill = hFov < vFov ? 1 : 0.62;
    const distance = (radius * fill) / Math.sin(Math.min(vFov, hFov) / 2);
    const from = new THREE.Vector3(...target);
    const dir = camera.position.clone().sub(from).normalize();
    if (dir.lengthSq() === 0) dir.set(0, 0.25, 1).normalize();
    camera.position.copy(from.addScaledVector(dir, distance));
    controls.maxDistance = Math.max(controls.maxDistance, distance * 1.5);
    controls.update();
    invalidate();
  }, [camera, controls, size.width, size.height, radius, target, invalidate]);

  useFrame(() => {
    if (!controls) return;
    controls.autoRotate = rotate;
    controls.update();
  });
  return null;
}

/** Faint background dust, seeded so it never jumps between renders. */
function Dust({ radius }: { radius: number }) {
  const geometry = useMemo(() => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const n = 1400;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = radius * (0.6 + rand() * 0.8);
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return g;
  }, [radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <points geometry={geometry}>
      <pointsMaterial
        color="#5b6984"
        size={1.2}
        sizeAttenuation={false}
        transparent
        opacity={0.5}
      />
    </points>
  );
}

function Cluster({
  project,
  animate,
  dimmed,
  highlighted,
  onHover,
}: {
  project: PlacedProject;
  animate: boolean;
  dimmed: boolean;
  highlighted: boolean;
  onHover: (id: string | null) => void;
}) {
  const router = useRouter();
  const { size, viewport, invalidate } = useThree();

  const stars = useMemo(() => {
    const n = project.stars.length;
    const positions = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const colors = new Float32Array(n * 3);
    const alphas = new Float32Array(n);
    const pulses = new Float32Array(n);
    const color = new THREE.Color();
    // Dense clusters would add up to a white blob: smaller stars the more there are.
    const density = Math.min(1, Math.max(0.5, 1.6 / Math.cbrt(Math.max(1, n) / 20)));
    project.stars.forEach((s, i) => {
      positions.set(s.position, i * 3);
      sizes[i] = s.size * density * (s.heat === 'cold' ? 1 : 1.35);
      color.set(HEAT_COLOR[s.heat]);
      colors.set([color.r, color.g, color.b], i * 3);
      alphas[i] = HEAT_ALPHA[s.heat];
      pulses[i] = s.heat === 'live' ? 1 : 0;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    g.setAttribute('aPulse', new THREE.BufferAttribute(pulses, 1));
    return g;
  }, [project]);

  const lines = useMemo(() => {
    const positions = new Float32Array(project.links.length * 6);
    const colors = new Float32Array(project.links.length * 6);
    const color = new THREE.Color();
    project.links.forEach(([a, b], i) => {
      const from = project.stars[a];
      const to = project.stars[b];
      positions.set(from?.position ?? [0, 0, 0], i * 6);
      positions.set(to?.position ?? [0, 0, 0], i * 6 + 3);
      // Each end takes its star's colour: a line glows where work happened and fades into quiet.
      for (const [k, star] of [from, to].entries()) {
        const heat = star?.heat ?? 'cold';
        color.set(HEAT_COLOR[heat]).multiplyScalar(ENERGY[heat].line);
        colors.set([color.r, color.g, color.b], i * 6 + k * 3);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  }, [project]);

  const signals = useMemo(() => {
    const routes = signalRoutes(project);
    const n = routes.length * SIGNAL_TRAIL;
    const starts = new Float32Array(n * 3);
    const ends = new Float32Array(n * 3);
    const lengths = new Float32Array(n);
    const phases = new Float32Array(n);
    const speeds = new Float32Array(n);
    const trails = new Float32Array(n);
    const colors = new Float32Array(n * 3);
    const brights = new Float32Array(n);
    const color = new THREE.Color();
    routes.forEach((r, i) => {
      // Routes run from the hotter end: work radiates from where it happened.
      const start = project.stars[r.from]?.position;
      const end = project.stars[r.to]?.position;
      if (!start || !end) return;
      const len = Math.max(
        0.5,
        Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]),
      );
      color.set(HEAT_COLOR[r.energy]);
      for (let k = 0; k < SIGNAL_TRAIL; k++) {
        const j = i * SIGNAL_TRAIL + k;
        starts.set(start, j * 3);
        ends.set(end, j * 3);
        lengths[j] = len;
        // Golden-ratio phases spread the signals evenly in time; speed is per unit of length.
        phases[j] = (i * 0.618034) % 1;
        speeds[j] = (ENERGY[r.energy].speed * 6) / (len + 6);
        trails[j] = k;
        colors.set([color.r, color.g, color.b], j * 3);
        brights[j] = ENERGY[r.energy].bright;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(starts, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(ends, 3));
    g.setAttribute('aLength', new THREE.BufferAttribute(lengths, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    g.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    g.setAttribute('aTrail', new THREE.BufferAttribute(trails, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('aBright', new THREE.BufferAttribute(brights, 1));
    // Signals sweep across the whole cluster: never cull them by the start points' bounds.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), project.radius * 1.5);
    return g;
  }, [project]);

  const signalMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: SIGNAL_VERTEX,
        fragmentShader: SIGNAL_FRAGMENT,
        uniforms: { uTime: { value: 0 }, uScale: { value: 300 }, uDim: { value: 1 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  useEffect(() => () => signals.dispose(), [signals]);
  useEffect(() => () => signalMaterial.dispose(), [signalMaterial]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: STAR_VERTEX,
        fragmentShader: STAR_FRAGMENT,
        uniforms: { uTime: { value: 0 }, uScale: { value: 300 }, uDim: { value: 1 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  // Each GPU resource is released with exactly the value it was created for.
  useEffect(() => () => stars.dispose(), [stars]);
  useEffect(() => () => lines.dispose(), [lines]);
  useEffect(() => () => material.dispose(), [material]);

  const lineMaterial = useRef<THREE.LineBasicMaterial>(null);
  // Hundreds of links would draw a hairball: fainter the more there are.
  const lineBase = 0.26 * Math.min(1, Math.sqrt(60 / Math.max(1, project.links.length)));
  useFrame(({ clock }) => {
    const uniforms = material.uniforms as Record<string, { value: number }>;
    if (uniforms.uTime) uniforms.uTime.value = animate ? shaderTime(clock.elapsedTime) : 0;
    // Point size scales with canvas height and pixel ratio: stars look alike on any screen.
    if (uniforms.uScale) uniforms.uScale.value = pointScale(size.height, viewport.dpr);
    const targetDim = dimmed ? 0.3 : 1;
    let settling = false;
    if (uniforms.uDim) {
      uniforms.uDim.value += (targetDim - uniforms.uDim.value) * 0.15;
      settling = Math.abs(targetDim - uniforms.uDim.value) > 0.01;
    }
    const signal = signalMaterial.uniforms as Record<string, { value: number }>;
    if (signal.uTime) signal.uTime.value = shaderTime(clock.elapsedTime);
    if (signal.uScale) signal.uScale.value = pointScale(size.height, viewport.dpr);
    if (signal.uDim) signal.uDim.value = uniforms.uDim?.value ?? 1;
    if (lineMaterial.current) {
      const targetLine = highlighted ? lineBase * 2.5 : dimmed ? lineBase * 0.3 : lineBase;
      lineMaterial.current.opacity += (targetLine - lineMaterial.current.opacity) * 0.15;
      settling ||= Math.abs(targetLine - lineMaterial.current.opacity) > 0.002;
    }
    // Frameloop "demand": keep asking for frames until the fade has finished.
    if (settling) invalidate();
  });
  // A hover change starts a fade, which needs a first frame in "demand" mode.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dimmed/highlighted are the triggers.
  useEffect(() => invalidate(), [dimmed, highlighted, invalidate]);

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onHover(project.id);
    document.body.style.cursor = 'pointer';
  };
  const out = () => {
    onHover(null);
    document.body.style.cursor = '';
  };
  useEffect(
    () => () => {
      document.body.style.cursor = '';
    },
    [],
  );

  return (
    <group position={project.center}>
      <points geometry={stars} material={material} />
      {/* Moving signals are motion: not drawn with reduced motion. */}
      {animate && <points geometry={signals} material={signalMaterial} />}
      <lineSegments geometry={lines}>
        <lineBasicMaterial
          ref={lineMaterial}
          vertexColors
          transparent
          opacity={lineBase}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
      {/* Invisible hit area: hovering anywhere in the cluster selects it. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a three.js mesh, not DOM; the project's label link is the keyboard equivalent. */}
      <mesh
        onPointerOver={over}
        onPointerOut={out}
        onClick={(e) => {
          e.stopPropagation();
          // A drag that turned the sky and ended on this cluster is not a click.
          if (e.delta > CLICK_SLOP) return;
          router.push(mapHref(project.fullName));
        }}
      >
        <sphereGeometry args={[project.radius, 16, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Moves each project's DOM label to the screen position just above its cluster. */
function Labels({
  projects,
  labels,
}: {
  projects: PlacedProject[];
  labels: React.RefObject<Map<string, HTMLAnchorElement>>;
}) {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  // Label sizes, measured when they change instead of read (forcing layout) on every frame.
  const sizes = useRef(new WeakMap<HTMLElement, { w: number; h: number }>());
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || projects.length === 0) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement;
        sizes.current.set(el, { w: el.offsetWidth, h: el.offsetHeight });
      }
    });
    for (const el of labels.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [labels, projects]);

  /** Shows or hides a label; a hidden one can't be focused or clicked. Writes only on change. */
  const show = (el: HTMLElement, on: boolean) => {
    const opacity = on ? '1' : '0';
    if (el.style.opacity === opacity) return;
    el.style.opacity = opacity;
    el.style.pointerEvents = on ? '' : 'none';
    el.tabIndex = on ? 0 : -1;
  };

  useFrame(() => {
    // Screen boxes above each cluster, then pushed down where they would overlap one another.
    const boxes: { el: HTMLAnchorElement; x: number; y: number; w: number; h: number }[] = [];
    for (const p of projects) {
      const el = labels.current.get(p.id);
      if (!el) continue;
      // Most of a cluster's light is in its inner part; the label sits just above that.
      v.set(p.center[0], p.center[1] + p.radius * 0.7, p.center[2]).project(camera);
      if (v.z > 1) {
        show(el, false); // behind the camera
        continue;
      }
      let measured = sizes.current.get(el);
      if (!measured) {
        measured = { w: el.offsetWidth, h: el.offsetHeight };
        sizes.current.set(el, measured);
      }
      const { w, h } = measured;
      // Kept inside the canvas so a name never runs off the edge.
      const x = Math.min(Math.max(((v.x + 1) / 2) * size.width, w / 2 + 6), size.width - w / 2 - 6);
      const y = Math.max(4, ((1 - v.y) / 2) * size.height - h - 6);
      boxes.push({ el, x, y, w, h });
    }
    boxes.sort((a, b) => a.y - b.y);
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i] as (typeof boxes)[number];
      for (let j = 0; j < i; j++) {
        const b = boxes[j] as (typeof boxes)[number];
        const overlapX = Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 4;
        if (overlapX && a.y < b.y + b.h + 4) a.y = b.y + b.h + 4;
      }
      // Pushed below the canvas: hidden, so it can't be focused or clicked out of sight.
      const onCanvas = a.y + a.h <= size.height - 4;
      show(a.el, onCanvas);
      if (!onCanvas) continue;
      const transform = `translate3d(${(a.x - a.w / 2).toFixed(1)}px, ${a.y.toFixed(1)}px, 0)`;
      if (a.el.style.transform !== transform) a.el.style.transform = transform;
    }
  });
  return null;
}
