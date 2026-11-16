import { repositoryMap } from '@waymark/db';
import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MapView } from '@/components/MapView';
import { db } from '@/lib/db';
import { compact, timeAgo } from '@/lib/format';
import { nameFromSegments } from '@/lib/paths';

export const dynamic = 'force-dynamic';

export default async function RepositoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string[] }>;
  searchParams: Promise<{ topic?: string | string[] }>;
}) {
  const { name } = await params;
  const { topic } = await searchParams;
  const fullName = nameFromSegments(name);
  const map = fullName === null ? null : await repositoryMap(db(), fullName);
  if (!map) notFound();

  const named = map.topics.filter((t) => t.source === 'ai').length;
  return (
    <main className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line px-5 py-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-text"
        >
          <ChevronLeft className="size-4" /> Projects
        </Link>
        <h1 className="text-base font-semibold tracking-tight text-text">
          {map.repository.fullName}
        </h1>
        <span className="text-xs text-faint">
          <span className="font-mono">{map.snapshot.commitSha.slice(0, 7)}</span> on{' '}
          {map.repository.defaultBranch} · indexed {timeAgo(map.snapshot.indexedAt)} ·{' '}
          {compact(map.snapshot.fileCount)} files · {map.topics.length} topics
          {named < map.topics.length && ` (${map.topics.length - named} awaiting AI names)`}
          {map.snapshot.truncated && ' · partial index (size limits reached)'}
        </span>
      </div>
      <MapView map={map} initialTopic={typeof topic === 'string' ? topic : undefined} />
    </main>
  );
}
