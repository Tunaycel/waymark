'use client';

import { Orbit } from 'lucide-react';
import dynamic from 'next/dynamic';
import { Component, type ReactNode, useEffect, useState } from 'react';
import type { OverviewProject } from '@/lib/constellation';

// three.js loads only when the sky is actually shown.
const Observatory = dynamic(() => import('./Observatory').then((m) => m.Observatory), {
  ssr: false,
  loading: () => <SkyPlaceholder text="Loading the sky…" />,
});

const STORAGE_KEY = 'waymark.overview';

type Mode = 'sky' | 'hidden';

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    // Give the probe context back at once: browsers allow only about 16 at a time.
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
}

function storedMode(): Mode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'sky' || v === 'hidden' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The 3D overview above the project cards. Shown when WebGL works and the viewer has not asked for
 * reduced motion; a toggle remembers the viewer's choice. Without it, the cards are the overview.
 */
export function OverviewSection({ projects }: { projects: OverviewProject[] }) {
  // Decided after mount: the server can't know about WebGL, motion settings, or the stored choice.
  const [state, setState] = useState<{ mode: Mode; webgl: boolean; reduced: boolean } | null>(null);
  // The sky failed at run time (no GPU context, chunk failed to load): hide it, keep the cards.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const webgl = webglAvailable();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const mode: Mode = !webgl ? 'hidden' : (storedMode() ?? (reduced ? 'hidden' : 'sky'));
    setState({ mode, webgl, reduced });
  }, []);

  const toggle = () => {
    if (!state) return;
    const mode: Mode = state.mode === 'sky' ? 'hidden' : 'sky';
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Private windows may refuse storage; the toggle still works for this visit.
    }
    setState({ ...state, mode });
  };

  if (projects.length === 0 || failed || (state && !state.webgl)) return null;

  return (
    <section aria-label="Overview" className="mb-8">
      <div className="mb-3 flex items-center justify-end">
        {state && (
          <button
            type="button"
            onClick={toggle}
            aria-pressed={state.mode === 'sky'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:border-line-strong hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Orbit className="size-3.5" />
            {state.mode === 'sky' ? 'Hide sky' : 'Show sky'}
          </button>
        )}
      </div>
      {/* Until the choice is known, the sky's space is reserved so the cards don't jump down. */}
      {(state === null || state.mode === 'sky') && (
        <div className="relative h-[clamp(320px,56vh,620px)] overflow-hidden rounded-2xl border border-line bg-[radial-gradient(ellipse_at_center,rgb(14_22_38/0.9),rgb(6_10_19/0.4)_70%)]">
          {state && (
            <SkyBoundary onError={() => setFailed(true)}>
              <Observatory projects={projects} animate={!state.reduced} />
              <SkyLegend />
            </SkyBoundary>
          )}
        </div>
      )}
    </section>
  );
}

/** Catches a crash inside the sky so it can never take the project list down with it. */
class SkyBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    console.error('overview sky failed', error);
    this.props.onError();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

function SkyPlaceholder({ text }: { text: string }) {
  return <div className="grid h-full place-items-center text-sm text-faint">{text}</div>;
}

function SkyLegend() {
  return (
    <p className="pointer-events-none absolute bottom-3 left-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-faint">
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-live shadow-[0_0_8px_var(--live-glow)]" /> changed
        today
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-accent" /> this week
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-muted/60" /> quiet
      </span>
      <span className="hidden sm:inline">Drag to orbit · scroll to zoom · click a project</span>
    </p>
  );
}
