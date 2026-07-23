import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { movieNightMatches, verdictParticipants } from '@/lib/queries';
import { thumbUrl } from '@/lib/cards';

export const runtime = 'nodejs';

/**
 * FORK: movie-night matches — titles ≥2 of the chosen users want to watch
 * (all participants when `users` is omitted). Query: users=<id,id,…>,
 * unwatched=1 (nobody on the server has watched it). Names are shown by
 * design — that's the matchmaking.
 */
export async function GET(req: Request) {
  try {
    const me = await requireUser();
    const p = new URL(req.url).searchParams;
    const userIds = (p.get('users') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const rows = movieNightMatches({
      userIds: userIds.length ? userIds : undefined,
      unwatchedOnly: p.get('unwatched') === '1',
    });
    const items = rows.map((r) => ({
      ratingKey: r.rating_key,
      title: r.title,
      year: r.year,
      libraryKind: r.library_kind,
      sizeBytes: r.size_bytes,
      thumbUrl: thumbUrl(r.thumb),
      imdbRating: r.imdb_rating ?? undefined,
      rtScore: r.rt_score ?? undefined,
      wantCount: r.want_count,
      wanterIds: r.wanter_ids.split(','),
      wanterNames: r.wanter_names.split(','),
    }));
    const users = verdictParticipants().map((u) => ({
      id: u.plex_user_id,
      username: u.username,
    }));
    return NextResponse.json({ items, users, me: me.plexUserId });
  } catch (e) {
    return errorResponse(e);
  }
}
