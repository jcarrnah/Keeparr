import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import {
  cancelDeletionsByTagger,
  createDeletionRule,
  deleteDeletionRule,
  listDeletionRules,
  updateDeletionRule,
} from '@/lib/queries';
import { parseRuleConditions } from '@/lib/rules';

export const runtime = 'nodejs';

interface RuleBody {
  id?: number;
  name?: string;
  conditions?: unknown; // RuleCondition[] (validated server-side)
  enabled?: boolean;
  graceDays?: number | null;
}

/** Validate the shared POST/PUT body; returns null (→ 400) when off. */
function validateRule(body: RuleBody) {
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) return null;
  const conditionsJson = JSON.stringify(body.conditions ?? null);
  if (!parseRuleConditions(conditionsJson)) return null;
  const graceDays =
    typeof body.graceDays === 'number' && body.graceDays >= 0
      ? Math.floor(body.graceDays)
      : null;
  return {
    name: body.name.trim(),
    conditions: conditionsJson,
    enabled: body.enabled === true,
    graceDays,
  };
}

/** FORK: list auto-tag rules. */
export async function GET() {
  try {
    await requireAdmin();
    const rules = listDeletionRules().map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled === 1,
      conditions: JSON.parse(r.conditions),
      graceDays: r.grace_days,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    return NextResponse.json({ rules });
  } catch (e) {
    return errorResponse(e);
  }
}

/** FORK: create a rule. Body: {name, conditions, enabled?, graceDays?}. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const input = validateRule((await req.json()) as RuleBody);
    if (!input) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    const id = createDeletionRule(input);
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return errorResponse(e);
  }
}

/** FORK: update a rule (full replace). Body: {id, name, conditions, enabled?, graceDays?}. */
export async function PUT(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json()) as RuleBody;
    if (typeof body.id !== 'number') {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    const input = validateRule(body);
    if (!input) return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    if (!updateDeletionRule(body.id, input)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * FORK: delete a rule. Body: {id}. Also CANCELS the rule's live (pending/held)
 * tags — a deleted rule's tags must not keep counting down. (Disabling a rule
 * instead keeps its tags live.) Returns how many tags were cancelled.
 */
export async function DELETE(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json()) as { id?: number };
    if (typeof body.id !== 'number') {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    if (!deleteDeletionRule(body.id)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const cancelledTags = cancelDeletionsByTagger(
      `rule:${body.id}`,
      `rule ${body.id} deleted`
    );
    return NextResponse.json({ ok: true, cancelledTags });
  } catch (e) {
    return errorResponse(e);
  }
}
