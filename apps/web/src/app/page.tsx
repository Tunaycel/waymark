import { listRepositoryCards, type RepositoryCard } from '@waymark/db';
import { GitCommitHorizontal, Lock, Network, StickyNote } from 'lucide-react';
import Link from 'next/link';
import { OverviewSection } from '@/components/OverviewSection';
import { requireScope } from '@/lib/auth';
import { db } from '@/lib/db';
import { compact, timeAgo } from '@/lib/format';
import { mapHref } from '@/lib/paths';

// Always read fresh data: the dashboard is a live view of the database.
export const dynamic = 'force-dynamic';

/** Projects drawn in the sky. Beyond this it stops being readable (and costs page weight). */
const OVERVIEW_PROJECTS = 60;

export default async function Home() {
  const cards = await listRepositoryCards(db(), await requireScope());
  const active = cards.filter((c) => c.commits7d > 0).length;

  return (
    <main className="mx-auto max-w-[1600px] px-5 pb-20 pt-10">
      <section className="mb-10">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-faint">Your projects</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text">
          {cards.length === 0
            ? 'Nothing mapped yet'
            : `${cards.length} ${cards.length === 1 ? 'repository' : 'repositories'}`}
        </h1>
        {cards.length > 0 && (
          <p className="mt-2 text-sm text-muted">
            {active > 0 ? `${active} active this week.` : 'No activity this week.'} Open one to see
            its map.
          </p>
        )}
      </section>

      <OverviewSection
        // The most recently pushed projects; all of them stay in the list below.
        projects={cards
          .filter((c) => c.constellation.stars.length > 0)
          .slice(0, OVERVIEW_PROJECTS)
          .map((c) => ({
            id: c.id,
            fullName: c.fullName,
            commits7d: c.commits7d,
            topicCount: c.snapshot?.topicCount ?? 0,
            constellation: c.constellation,
          }))}
      />

      {cards.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr))]">
          {cards.map((card) => (
            <li key={card.id}>
              <RepoCardView card={card} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function RepoCardView({ card }: { card: RepositoryCard }) {
  const [owner, name] = card.fullName.split('/');
  const live = card.commits7d > 0;
  const snap = card.snapshot;
  const totalLines = snap?.languages.reduce((n, l) => n + l.lines, 0) ?? 0;

  return (
    <Link
      href={mapHref(card.fullName)}
      className="group relative flex h-full flex-col rounded-2xl border border-line bg-panel/70 p-5 transition hover:border-line-strong hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-accent"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs text-faint">{owner}</p>
          <h2 className="truncate text-lg font-semibold tracking-tight text-text">{name}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {card.isPrivate && <Lock className="size-3.5 text-faint" aria-label="Private" />}
          <span
            className={`size-2.5 rounded-full ${live ? 'live-pulse bg-live' : 'bg-faint/40'}`}
            title={live ? 'Active this week' : 'Quiet this week'}
          />
        </div>
      </div>

      {snap ? (
        <>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted">
            <Stat icon={<Network className="size-3.5" />} value={snap.topicCount} label="topics" />
            <Stat
              icon={<GitCommitHorizontal className="size-3.5" />}
              value={card.commits7d}
              label="commits this week"
            />
            {snap.markerCount > 0 && (
              <Stat
                icon={<StickyNote className="size-3.5 text-todo" />}
                value={snap.markerCount}
                label="TODOs"
              />
            )}
          </div>

          {totalLines > 0 && (
            <div className="mt-4">
              <div className="flex h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                {snap.languages.map((l, i) => (
                  <span
                    key={l.name}
                    style={{ width: `${(l.lines / totalLines) * 100}%`, opacity: 1 - i * 0.2 }}
                    className="bg-accent"
                  />
                ))}
              </div>
              <p className="mt-2 truncate text-xs text-faint">
                {snap.languages.map((l) => l.name).join(' · ')}
                {snap.frameworks.length > 0 && ` — ${snap.frameworks.slice(0, 3).join(', ')}`}
              </p>
            </div>
          )}

          {card.activeTopics.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {card.activeTopics.slice(0, 4).map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-live/30 bg-live/10 px-2.5 py-0.5 text-xs text-live"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          <p className="mt-auto pt-5 text-xs text-faint">
            {card.lastPushAt
              ? `Last push ${timeAgo(card.lastPushAt)}`
              : `Indexed ${timeAgo(snap.indexedAt)}`}
            {' · '}
            {compact(snap.fileCount)} files
          </p>
        </>
      ) : (
        <p className="mt-4 text-sm text-muted">Not indexed yet.</p>
      )}
    </Link>
  );
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {icon}
      <span className="font-medium text-text tabular-nums">{compact(value)}</span>
      <span>{label}</span>
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-panel/50 p-8 text-sm text-muted">
      <p className="text-text">Connect a GitHub App, or load a repository locally:</p>
      <pre className="mt-4 overflow-x-auto rounded-lg bg-raised p-4 font-mono text-[13px] text-accent">
        pnpm demo .{'\n'}pnpm demo fastify/fastify --describe
      </pre>
    </div>
  );
}
