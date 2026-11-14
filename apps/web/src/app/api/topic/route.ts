import { topicDetail } from '@waymark/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Query = z.object({
  repository: z.uuid(),
  snapshot: z.uuid(),
  // Topic ids are short hex hashes; anything else (control characters, NUL) never reaches SQL.
  topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

/** Side-panel data for one topic. Read-only; parameters validated before touching the database. */
export async function GET(request: Request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = Query.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid parameters' }, { status: 400 });
  }
  const { repository, snapshot, topic } = parsed.data;
  const detail = await topicDetail(db(), repository, snapshot, topic);
  if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(detail, { headers: { 'cache-control': 'no-store' } });
}
