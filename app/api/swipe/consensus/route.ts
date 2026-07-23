import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { verdictConsensus } from '@/lib/queries';
import { thumbUrl } from '@/lib/cards';

export const runtime = 'nodejs';

const PAGE = 60;

/**
 * FORK: per-item verdict rollup (who wants it / keeps it / is done with it) —
 * the human input for deciding what to tag for deletion. Query:
 * sort=votes|size (default votes = most delete votes first), offset.
 */
export async function GET(req: Request) {
  try {
    await requireUser();
    const p = new URL(req.url).searchParams;
    const sort = p.get('sort') === 'size' ? 'size' : ('votes' as const);
    const offset = Math.max(0, Number(p.get('offset')) || 0);
    const rows = verdictConsensus({ sort, limit: PAGE + 1, offset });
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
    }));
    return NextResponse.json({
      items,
      hasMore: rows.length > PAGE,
      nextOffset: offset + PAGE,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
