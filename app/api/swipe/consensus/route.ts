import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { consensusVoters, verdictConsensus } from '@/lib/queries';
import { thumbUrl } from '@/lib/cards';
import { VERDICTS, type Verdict } from '@/lib/types';

export const runtime = 'nodejs';

const PAGE = 60;

const SORTS = ['votes', 'size', 'score'] as const;
type Sort = (typeof SORTS)[number];

/**
 * FORK: per-item verdict rollup (who wants it / keeps it / is done with it) —
 * the human input for deciding what to tag for deletion. Query:
 * sort=votes|size|score (default votes = most delete votes first), offset, and
 * voter/verdict to slice by who said what. Unknown sort/verdict values fall
 * back to the default rather than erroring — this is a browse surface.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const p = new URL(req.url).searchParams;
    const sortParam = p.get('sort') ?? '';
    const sort: Sort = (SORTS as readonly string[]).includes(sortParam)
      ? (sortParam as Sort)
      : 'votes';
    const verdictParam = p.get('verdict') ?? '';
    const verdict = VERDICTS.includes(verdictParam as Verdict)
      ? (verdictParam as Verdict)
      : undefined;
    const voter = p.get('voter') || undefined;
    const offset = Math.max(0, Number(p.get('offset')) || 0);
    const rows = verdictConsensus({ sort, voter, verdict, limit: PAGE + 1, offset });
    const split = (csv: string | null) => (csv ? csv.split(',') : []);
    const items = rows.slice(0, PAGE).map((r) => ({
      ratingKey: r.rating_key,
      title: r.title,
      year: r.year,
      libraryKind: r.library_kind,
      sizeBytes: r.size_bytes,
      thumbUrl: thumbUrl(r.thumb),
      kept: r.kept === 1,
      wantNames: split(r.want_names),
      keepNames: split(r.keep_names),
      doneNames: split(r.done_names),
      neverNames: split(r.never_names),
      skipCount: r.skip_count,
      deleteVotes: r.delete_votes,
      // FORK (3.3): the weighted projection + the people whose opinion was
      // inferred from a keep / "don't care" / "OK to delete" rather than a swipe.
      score: r.score,
      voters: r.voters,
      keepImplicitNames: split(r.keep_implicit_names),
      doneImplicitNames: split(r.done_implicit_names),
      skipImplicitCount: r.skip_implicit_count,
    }));
    return NextResponse.json({
      items,
      // So the voter filter can say "You" without the Movie night tab having
      // loaded first (each tab fetches independently).
      me: user.plexUserId,
      voters: consensusVoters().map((v) => ({
        id: v.plex_user_id,
        username: v.username ?? v.plex_user_id,
      })),
      hasMore: rows.length > PAGE,
      nextOffset: offset + PAGE,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
