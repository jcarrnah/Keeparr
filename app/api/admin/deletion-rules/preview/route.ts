import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { ratingKeysMatchingRule } from '@/lib/queries';
import { parseRuleConditions } from '@/lib/rules';

export const runtime = 'nodejs';

/**
 * FORK: preview what a rule's conditions would tag right now (same baseline as
 * the job: kept + already-tagged items excluded). Body: {conditions}.
 * Returns the match count + the largest few titles.
 */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json()) as { conditions?: unknown };
    const conds = parseRuleConditions(JSON.stringify(body.conditions ?? null));
    if (!conds) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    const matches = ratingKeysMatchingRule(conds);
    const totalBytes = matches.reduce((a, m) => a + m.size_bytes, 0);
    return NextResponse.json({
      count: matches.length,
      totalBytes,
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
