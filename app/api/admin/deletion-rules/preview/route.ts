import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { ratingKeysMatchingRule } from '@/lib/queries';
import { parseRuleConditions } from '@/lib/rules';
import { effectiveMinVoters } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * FORK: preview what a rule's conditions would tag right now (same baseline as
 * the job: kept + already-tagged items excluded). Body: {conditions}.
 * Returns the match count + the largest few titles.
 *
 * FORK (3.2): also reports the voter quorum in force and how many titles it
 * held back. A rule that quietly matches 3 instead of 15 reads as a broken
 * rule; "12 held back: fewer than 2 people voted" reads as the guard working,
 * and points at the fix (lower min_voters, or go get more votes).
 */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json()) as { conditions?: unknown };
    const conds = parseRuleConditions(JSON.stringify(body.conditions ?? null));
    if (!conds) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    const matches = ratingKeysMatchingRule(conds);
    const totalBytes = matches.reduce((a, m) => a + m.size_bytes, 0);
    const minVoters = effectiveMinVoters(conds);
    // Only worth the second query when a quorum can actually exclude something.
    const heldByQuorum =
      minVoters != null && minVoters > 1
        ? ratingKeysMatchingRule(conds, undefined, { minVoters: 0 }).length - matches.length
        : 0;
    return NextResponse.json({
      count: matches.length,
      totalBytes,
      minVoters,
      heldByQuorum,
      sample: matches.slice(0, 10).map((m) => ({
        ratingKey: m.rating_key,
        title: m.title,
        sizeBytes: m.size_bytes,
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
