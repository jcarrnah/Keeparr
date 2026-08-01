/**
 * FORK: rule-based auto-tagging (Maintainerr-style). The nightly 'rules' job
 * evaluates each enabled rule and inserts matches into scheduled_deletions
 * with the rule's grace (or the global default). Non-negotiables enforced by
 * the match query itself (lib/queries.ts ratingKeysMatchingRule): kept items
 * are never tagged, and an existing tag of ANY status is never overwritten.
 * Inert while the Deletion master toggle is off.
 */
import { sendDiscordMessage } from './discord';
import {
  insertRuleTags,
  listDeletionRules,
  logEvent,
  ratingKeysMatchingRule,
} from './queries';
import { getDeletionEnabled, getDeletionGraceDays } from './settings';
import type { RuleCondition, Verdict } from './types';
import { RULE_FIELDS, VERDICTS } from './types';
import type { JobResult } from './sync';

/**
 * Validate a stored/incoming conditions JSON. Returns the typed conditions or
 * null when anything is off — a malformed rule must never partially apply.
 */
export function parseRuleConditions(json: string): RuleCondition[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: RuleCondition[] = [];
  // A whole number in range — the vote fields are counts and thresholds, and a
  // fractional quorum ("1.5 people") would be nonsense the SQL wouldn't reject.
  const int = (v: unknown, min = -Infinity) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min;
  for (const c of raw) {
    if (!c || typeof c !== 'object') return null;
    const { field, op, value } = c as { field?: unknown; op?: unknown; value?: unknown };
    const verdict = (c as { verdict?: unknown }).verdict;
    if (!(RULE_FIELDS as readonly string[]).includes(String(field))) return null;
    switch (field) {
      case 'last_watched_any':
      case 'added_at':
        if (op !== 'olderThanDays' || typeof value !== 'number' || value < 0) return null;
        out.push({ field, op, value } as RuleCondition);
        break;
      case 'size':
        if ((op !== 'gtGB' && op !== 'ltGB') || typeof value !== 'number' || value < 0) return null;
        out.push({ field, op, value } as RuleCondition);
        break;
      case 'library':
        if (op !== 'in' || !Array.isArray(value) || !value.every((v) => typeof v === 'string')) return null;
        out.push({ field, op, value } as RuleCondition);
        break;
      case 'requested':
        if (op !== 'eq' || typeof value !== 'boolean') return null;
        out.push({ field, op, value } as RuleCondition);
        break;
      // --- FORK (3.2): opinion-matching conditions ---
      case 'verdict_score':
        // Signed: a negative threshold ("score ≤ −2") is a legitimate way to
        // ask for titles the household is protective of.
        if ((op !== 'gte' && op !== 'lte') || !int(value)) return null;
        out.push({ field, op, value } as RuleCondition);
        break;
      case 'verdict_count':
        if ((op !== 'gte' && op !== 'lte') || !int(value, 0)) return null;
        if (!VERDICTS.includes(verdict as Verdict)) return null;
        out.push({ field, op, value, verdict } as RuleCondition);
        break;
      case 'verdict_by':
        if (op !== 'eq' || typeof value !== 'string' || !value.trim()) return null;
        if (!VERDICTS.includes(verdict as Verdict)) return null;
        out.push({ field, op, value, verdict } as RuleCondition);
        break;
      case 'min_voters':
        // At least one: a rule that matches on votes while requiring nobody to
        // have voted is a contradiction, not a configuration.
        if (op !== 'gte' || !int(value, 1)) return null;
        // Two of them would leave the builder's "effective quorum" and the SQL
        // disagreeing about which one is in force — refuse rather than pick.
        if (out.some((o) => o.field === 'min_voters')) return null;
        out.push({ field, op, value } as RuleCondition);
        break;
      case 'nobody_kept':
        // Only `true`. The baseline already excludes kept items, so this states
        // the guarantee; `false` would be a rule that can never match anything.
        if (op !== 'eq' || value !== true) return null;
        out.push({ field, op, value } as RuleCondition);
        break;
      default:
        return null;
    }
  }
  return out;
}

export async function runRules(): Promise<JobResult> {
  if (!getDeletionEnabled()) {
    return { result: 0, message: 'Scheduled deletion is disabled — rules not evaluated.' };
  }
  const rules = listDeletionRules().filter((r) => r.enabled === 1);
  const nowSec = Math.floor(Date.now() / 1000);
  let tagged = 0;
  let invalid = 0;

  for (const rule of rules) {
    const conds = parseRuleConditions(rule.conditions);
    if (!conds) {
      invalid++;
      logEvent('warn', 'job:rules', `Rule "${rule.name}" has invalid conditions — skipped.`);
      continue;
    }
    const matches = ratingKeysMatchingRule(conds, nowSec);
    if (matches.length === 0) continue;
    const grace = rule.grace_days ?? getDeletionGraceDays();
    const n = insertRuleTags(
      matches.map((m) => m.rating_key),
      `rule:${rule.id}`,
      nowSec + grace * 86400
    );
    tagged += n;
    if (n > 0) {
      logEvent(
        'info',
        'job:rules',
        `Rule "${rule.name}" tagged ${n} item(s) for deletion (grace ${grace}d).`
      );
      const sample = matches.slice(0, 8).map((m) => m.title).join(', ');
      await sendDiscordMessage(
        `🏷️ Rule **${rule.name}** tagged ${n} item(s) for deletion in ${grace} days — e.g. ${sample}${matches.length > 8 ? ', …' : ''}. Keep anything you want to rescue.`
      );
    }
  }

  const parts = [`${rules.length} rule(s) evaluated`, `tagged ${tagged} item(s)`];
  if (invalid) parts.push(`${invalid} invalid`);
  return { result: tagged, message: parts.join('; ') + '.' };
}
