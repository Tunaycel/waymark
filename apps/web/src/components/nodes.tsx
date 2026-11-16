'use client';

import type { MapTopic } from '@waymark/db';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { ChevronRight, Sparkles, StickyNote } from 'lucide-react';
import { memo } from 'react';
import { compact, heatOf, roleColor, timeAgo } from '@/lib/format';

export interface TopicNodeData extends Record<string, unknown> {
  topic: MapTopic;
  caption: string | null;
  dimmed: boolean;
  selected: boolean;
}

export interface CollapsedNodeData extends Record<string, unknown> {
  label: string;
  topicCount: number;
  fileCount: number;
  markerCount: number;
  lastChangedAt: string | null;
  dimmed: boolean;
}

export interface RegionNodeData extends Record<string, unknown> {
  label: string;
  topicCount: number;
  dimmed: boolean;
}

const handle = 'opacity-0 !min-h-0 !min-w-0 !size-1 !border-0';

function HeatDot({ lastChangedAt }: { lastChangedAt: string | null }) {
  const heat = heatOf(lastChangedAt);
  if (heat === 'cold') return null;
  return (
    <span
      className={`size-2 shrink-0 rounded-full bg-live ${heat === 'live' ? 'live-pulse' : 'opacity-60'}`}
      title={heat === 'live' ? 'Changed in the last 24 hours' : 'Changed this week'}
    />
  );
}

export const TopicNode = memo(function TopicNode({ data }: NodeProps) {
  const { topic, caption, dimmed, selected } = data as TopicNodeData;
  const heat = heatOf(topic.lastChangedAt);
  const files = topic.fileCount + topic.testCount;
  return (
    <div
      className={[
        'group relative flex h-[76px] w-[232px] cursor-pointer rounded-xl border bg-panel/95 transition',
        selected
          ? 'border-accent shadow-[0_0_0_1px_var(--accent),0_0_28px_-6px_var(--accent)]'
          : heat === 'live'
            ? 'border-live/50 shadow-[0_0_24px_-8px_var(--live-glow)]'
            : 'border-line hover:border-line-strong',
        dimmed ? 'opacity-25' : 'opacity-100',
      ].join(' ')}
    >
      <Handle type="target" position={Position.Left} className={handle} />
      {caption && (
        <span className="absolute -top-[18px] left-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
          {caption}
        </span>
      )}
      <span className="w-1 shrink-0 rounded-l-xl" style={{ background: roleColor(topic.role) }} />
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-3">
        <div className="flex items-center gap-1.5">
          <HeatDot lastChangedAt={topic.lastChangedAt} />
          <span
            className={`truncate text-[13.5px] font-semibold leading-tight ${topic.source === 'ai' ? 'text-text' : 'text-muted'}`}
            title={topic.source === 'ai' ? topic.name : `${topic.name} (provisional name)`}
          >
            {topic.name}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-faint">
          <span className="tabular-nums">{compact(files)} files</span>
          {heat === 'cold' || !topic.lastChangedAt ? (
            <span className="tabular-nums">{compact(topic.lineCount)} lines</span>
          ) : (
            // Recently changed: when matters more than how big.
            <span className={heat === 'live' ? 'text-live' : 'text-muted'}>
              {timeAgo(topic.lastChangedAt)}
            </span>
          )}
          {topic.markerCount > 0 && (
            <span
              className="ml-auto inline-flex items-center gap-0.5 text-todo"
              title="TODO / FIXME"
            >
              <StickyNote className="size-3" />
              {topic.markerCount}
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className={handle} />
    </div>
  );
});

export const CollapsedRegionNode = memo(function CollapsedRegionNode({ data }: NodeProps) {
  const d = data as CollapsedNodeData;
  return (
    <div
      className={`flex h-[92px] w-[252px] cursor-pointer flex-col justify-center gap-1.5 rounded-2xl border border-line-strong bg-raised/95 px-4 transition hover:border-accent/60 ${d.dimmed ? 'opacity-25' : ''}`}
      title="Click to expand"
    >
      <Handle type="target" position={Position.Left} className={handle} />
      <div className="flex items-center gap-1.5">
        <HeatDot lastChangedAt={d.lastChangedAt} />
        <span className="truncate text-sm font-semibold text-text">{d.label}</span>
        <ChevronRight className="ml-auto size-4 shrink-0 text-faint" />
      </div>
      <div className="flex gap-3 text-[11px] text-faint">
        <span>{d.topicCount} topics</span>
        <span>{compact(d.fileCount)} files</span>
        {d.markerCount > 0 && <span className="text-todo">{d.markerCount} TODOs</span>}
      </div>
      <Handle type="source" position={Position.Right} className={handle} />
    </div>
  );
});

export const RegionNode = memo(function RegionNode({ data }: NodeProps) {
  const d = data as RegionNodeData;
  return (
    <div
      className={`h-full w-full rounded-3xl border border-line bg-[linear-gradient(180deg,rgb(148_163_184/0.05),rgb(148_163_184/0.015))] ${d.dimmed ? 'opacity-40' : ''}`}
    >
      <div className="flex items-center gap-2 px-5 pt-4 text-xs">
        <Sparkles className="size-3.5 text-accent/70" />
        <span className="font-semibold uppercase tracking-[0.14em] text-muted">{d.label}</span>
        <span className="text-faint">{d.topicCount}</span>
      </div>
    </div>
  );
});

export const nodeTypes = {
  topic: TopicNode,
  collapsed: CollapsedRegionNode,
  region: RegionNode,
};
