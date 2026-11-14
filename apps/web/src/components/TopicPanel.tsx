'use client';

import type { MapTopic, RepositoryMap, TopicDetail } from '@waymark/db';
import {
  ArrowDownLeft,
  ArrowUpRight,
  FileCode2,
  GitCommitHorizontal,
  StickyNote,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { compact, heatOf, ROLE_LABELS, roleColor, timeAgo } from '@/lib/format';
import { neighbours } from '@/lib/graph';

interface Props {
  map: RepositoryMap;
  topic: MapTopic;
  onSelect: (topicId: string) => void;
  onClose: () => void;
}

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; detail: TopicDetail };

export function TopicPanel({ map, topic, onSelect, onClose }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const { uses, usedBy } = neighbours(map, topic.id);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    const query = new URLSearchParams({
      repository: map.repository.id,
      snapshot: map.snapshot.id,
      topic: topic.id,
    });
    fetch(`/api/topic?${query}`, { signal: controller.signal })
      .then((res) =>
        res.ok
          ? (res.json() as Promise<TopicDetail>)
          : Promise.reject(new Error(String(res.status))),
      )
      .then((detail) => setState({ status: 'ready', detail }))
      .catch((err: unknown) => {
        if ((err as Error).name !== 'AbortError') setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [map.repository.id, map.snapshot.id, topic.id]);

  const heat = heatOf(topic.lastChangedAt);
  return (
    <aside
      className="absolute inset-y-0 right-0 z-20 flex w-[min(420px,100%)] flex-col border-l border-line bg-bg/95 backdrop-blur-xl"
      aria-label={`Topic: ${topic.name}`}
    >
      <div className="flex items-start gap-3 border-b border-line p-5">
        <span
          className="mt-1 h-10 w-1 shrink-0 rounded-full"
          style={{ background: roleColor(topic.role) }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">
            {topic.role ? ROLE_LABELS[topic.role] : 'Topic'}
            {topic.directory && (
              <span className="normal-case tracking-normal"> · {topic.directory}</span>
            )}
          </p>
          <h2 className="mt-1 text-xl font-semibold leading-snug tracking-tight text-text">
            {topic.name}
          </h2>
          {topic.source !== 'ai' && (
            <p className="mt-1 text-xs text-faint">Provisional name (no AI description yet)</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-faint hover:bg-panel hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto p-5 text-sm">
        {topic.summary && <p className="leading-relaxed text-muted">{topic.summary}</p>}

        <dl className="grid grid-cols-3 gap-2">
          <Metric label="files" value={compact(topic.fileCount)} />
          <Metric label="tests" value={compact(topic.testCount)} />
          <Metric label="lines" value={compact(topic.lineCount)} />
        </dl>

        <p className="text-xs text-faint">
          {heat === 'cold'
            ? 'No changes in the last 30 days.'
            : `Last changed ${timeAgo(topic.lastChangedAt)} · ${topic.commits30d} commit${topic.commits30d === 1 ? '' : 's'} in 30 days`}
          {topic.externals.length > 0 && <> · uses {topic.externals.slice(0, 4).join(', ')}</>}
        </p>

        {(uses.length > 0 || usedBy.length > 0) && (
          <section className="space-y-3">
            <Links
              title="Uses"
              icon={<ArrowUpRight className="size-3.5" />}
              items={uses}
              onSelect={onSelect}
            />
            <Links
              title="Used by"
              icon={<ArrowDownLeft className="size-3.5" />}
              items={usedBy}
              onSelect={onSelect}
            />
          </section>
        )}

        {state.status === 'loading' && <p className="text-xs text-faint">Loading details…</p>}
        {state.status === 'error' && (
          <p className="text-xs text-[var(--danger)]">Could not load details.</p>
        )}
        {state.status === 'ready' && (
          <>
            {state.detail.markers.length > 0 && (
              <Section title="TODO / FIXME" icon={<StickyNote className="size-3.5 text-todo" />}>
                <ul className="space-y-2">
                  {state.detail.markers.slice(0, 12).map((m) => (
                    <li
                      key={`${m.path}:${m.line}:${m.kind}:${m.text}`}
                      className="rounded-lg border border-line bg-panel/60 px-3 py-2"
                    >
                      <p className="text-[13px] text-text">
                        <span className="mr-1.5 text-[11px] font-semibold text-todo">{m.kind}</span>
                        {m.text || '(no text)'}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-faint">
                        {m.path}:{m.line}
                      </p>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {state.detail.commits.length > 0 && (
              <Section title="Recent commits" icon={<GitCommitHorizontal className="size-3.5" />}>
                <ul className="space-y-2">
                  {state.detail.commits.slice(0, 8).map((c) => (
                    <li key={c.sha} className="flex gap-3">
                      <span className="mt-0.5 font-mono text-[11px] text-faint">
                        {c.sha.slice(0, 7)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-text">{c.message}</span>
                        <span className="text-[11px] text-faint">
                          {c.authorName} · {timeAgo(c.at)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section
              title={`Files (${state.detail.fileCount})`}
              icon={<FileCode2 className="size-3.5" />}
            >
              <ul className="space-y-1">
                {state.detail.files.map((f) => (
                  <li
                    key={f.path}
                    className="group flex items-baseline gap-2"
                    title={f.symbols.join(', ')}
                  >
                    <span
                      className={`min-w-0 flex-1 truncate font-mono text-[12px] ${f.kind === 'test' ? 'text-faint' : 'text-muted'}`}
                    >
                      {f.path}
                    </span>
                    {f.lines !== null && (
                      <span className="shrink-0 text-[11px] tabular-nums text-faint">
                        {f.lines}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel/60 px-3 py-2.5">
      <dd className="text-lg font-semibold tabular-nums text-text">{value}</dd>
      <dt className="text-[11px] text-faint">{label}</dt>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function Links({
  title,
  icon,
  items,
  onSelect,
}: {
  title: string;
  icon: React.ReactNode;
  items: { topic: MapTopic; weight: number }[];
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
        {icon}
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.slice(0, 10).map(({ topic, weight }) => (
          <button
            key={topic.id}
            type="button"
            onClick={() => onSelect(topic.id)}
            className="rounded-full border border-line bg-panel px-2.5 py-1 text-xs text-muted transition hover:border-accent/50 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            title={`${weight} import${weight === 1 ? '' : 's'}`}
          >
            {topic.name}
          </button>
        ))}
      </div>
    </div>
  );
}
