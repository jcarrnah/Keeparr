import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { ratingKeysMatchingRule, ruleExclusionCounts } from '@/lib/queries';
import { parseRuleConditions } from '@/lib/rules';
import { effectiveMinVoters } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * FORK: preview what a rule's conditions would tag right now (same baseline as
 * the job: kept + already-tagged items excluded). Body: {conditions}.
 * Returns the match count + the largest few titles.
 *
 * FORK (3.2): also reports the voter quorum in force and, for each part of the
 * baseline, how many titles it removed. A rule matching 3 where the same filter
 * in Browse lists 40 reads as broken; "31 already tagged, 6 kept" reads as the
 * baseline doing its job — and Browse applies none of it, which is exactly why
 * the two screens disagree.
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
    // Why the count is lower than the same conditions look like they'd give —
    // Browse applies none of this baseline, so the two screens disagree by
    // exactly these three numbers.
    const excluded = ruleExclusionCounts(conds);
    return NextResponse.json({
      count: matches.length,
      totalBytes,
      minVoters,
      heldByQuorum: excluded.quorum,
      excludedKept: excluded.kept,
      excludedTagged: excluded.tagged,
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
