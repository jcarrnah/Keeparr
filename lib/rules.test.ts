/** FORK: deletion-rules engine tests (real in-memory SQLite, no mocks). */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { __setTestDbToMemory, __closeDb } from './db';
import {
  addDelete,
  addKeep,
  applyVerdict,
  cancelDeletionsByTagger,
  createDeletionRule,
  removeVerdict,
  ruleExclusionCounts,
  listScheduledDeletions,
  ratingKeysMatchingRule,
  replaceSeerrRequests,
  tagForDeletion,
  upsertMediaBatch,
  upsertWatchBatch,
  type UpsertMediaInput,
} from './queries';
import { setDeletionEnabled, setDeletionGraceDays } from './settings';
import { parseRuleConditions, runRules } from './rules';
import { DEFAULT_MIN_VOTERS, effectiveMinVoters, type RuleCondition } from './types';

const GB = 1024 ** 3;
const nowSec = Math.floor(Date.now() / 1000);
const dago = (d: number) => nowSec - d * 86400;

function media(ratingKey: string, overrides: Partial<UpsertMediaInput> = {}): UpsertMediaInput {
  return {
    ratingKey,
    sectionId: '1',
    libraryKind: 'movie',
    title: `Title ${ratingKey}`,
    year: 2020,
    thumb: null,
    sizeBytes: 1 * GB,
    addedAt: dago(400),
    guidTmdb: null,
    guidTvdb: null,
    ...overrides,
  };
}

beforeEach(() => {
  __setTestDbToMemory();
});

afterAll(() => {
  __closeDb();
});

describe('parseRuleConditions', () => {
  it('accepts every vocabulary field', () => {
    const conds: RuleCondition[] = [
      { field: 'last_watched_any', op: 'olderThanDays', value: 180 },
      { field: 'added_at', op: 'olderThanDays', value: 365 },
      { field: 'size', op: 'gtGB', value: 20 },
      { field: 'library', op: 'in', value: ['1', '2'] },
      { field: 'requested', op: 'eq', value: false },
      { field: 'verdict_score', op: 'gte', value: 3 },
      { field: 'verdict_count', op: 'gte', value: 2, verdict: 'not_interested' },
      { field: 'verdict_by', op: 'eq', value: 'u1', verdict: 'done_with_it' },
      { field: 'min_voters', op: 'gte', value: 1 },
      { field: 'nobody_kept', op: 'eq', value: true },
    ];
    expect(parseRuleConditions(JSON.stringify(conds))).toEqual(conds);
  });

  it('FORK (3.2): rejects vote conditions that would run ambiguously', () => {
    const one = (c: unknown) => parseRuleConditions(JSON.stringify([c]));
    // A verdict field with no verdict, or a verdict nobody can cast.
    expect(one({ field: 'verdict_count', op: 'gte', value: 2 })).toBeNull();
    expect(one({ field: 'verdict_by', op: 'eq', value: 'u1', verdict: 'meh' })).toBeNull();
    expect(one({ field: 'verdict_by', op: 'eq', value: '', verdict: 'loved_it' })).toBeNull();
    // A quorum of nobody, or a fractional one.
    expect(one({ field: 'min_voters', op: 'gte', value: 0 })).toBeNull();
    expect(one({ field: 'verdict_score', op: 'gte', value: 1.5 })).toBeNull();
    // Two quorums would leave the builder and the engine disagreeing.
    expect(
      parseRuleConditions(
        JSON.stringify([
          { field: 'min_voters', op: 'gte', value: 1 },
          { field: 'min_voters', op: 'gte', value: 3 },
        ])
      )
    ).toBeNull();
    // "Nobody keeps it" is a guarantee, not a switch — false can never match.
    expect(one({ field: 'nobody_kept', op: 'eq', value: false })).toBeNull();
    // A negative score threshold IS legitimate: "the household protects this".
    expect(one({ field: 'verdict_score', op: 'lte', value: -2 })).not.toBeNull();
  });

  it('FORK (3.2): effectiveMinVoters — default, override, and not-applicable', () => {
    expect(effectiveMinVoters([{ field: 'size', op: 'gtGB', value: 20 }])).toBeNull();
    expect(effectiveMinVoters([{ field: 'verdict_score', op: 'gte', value: 3 }])).toBe(
      DEFAULT_MIN_VOTERS
    );
    expect(
      effectiveMinVoters([
        { field: 'verdict_score', op: 'gte', value: 3 },
        { field: 'min_voters', op: 'gte', value: 1 },
      ])
    ).toBe(1);
    // An explicit quorum on a rule that reads no opinions still stands — it's
    // then simply "at least N people have an opinion about this at all".
    expect(effectiveMinVoters([{ field: 'min_voters', op: 'gte', value: 3 }])).toBe(3);
  });

  it('rejects malformed input wholesale', () => {
    expect(parseRuleConditions('not json')).toBeNull();
    expect(parseRuleConditions('null')).toBeNull();
    expect(parseRuleConditions('[]')).toBeNull(); // empty = matches everything — refuse
    expect(parseRuleConditions(JSON.stringify([{ field: 'size', op: 'gtGB', value: -1 }]))).toBeNull();
    expect(parseRuleConditions(JSON.stringify([{ field: 'nope', op: 'eq', value: 1 }]))).toBeNull();
    expect(
      parseRuleConditions(
        JSON.stringify([
          { field: 'size', op: 'gtGB', value: 20 },
          { field: 'library', op: 'in', value: [1] }, // non-string id
        ])
      )
    ).toBeNull();
  });
});

describe('ratingKeysMatchingRule', () => {
  beforeEach(() => {
    upsertMediaBatch([
      media('big-old', { sizeBytes: 30 * GB, addedAt: dago(400) }),
      media('big-new', { sizeBytes: 30 * GB, addedAt: dago(10) }),
      media('small-old', { sizeBytes: 1 * GB, addedAt: dago(400) }),
      media('watched-recent', { sizeBytes: 30 * GB, addedAt: dago(400) }),
      media('other-lib', { sizeBytes: 30 * GB, sectionId: '2', addedAt: dago(400) }),
    ]);
    upsertWatchBatch([
      { plexUserId: 'userB', ratingKey: 'watched-recent', plays: 1, lastWatched: dago(5) },
      { plexUserId: 'userB', ratingKey: 'big-old', plays: 1, lastWatched: dago(300) },
    ]);
  });

  const keys = (conds: RuleCondition[]) =>
    ratingKeysMatchingRule(conds, nowSec).map((r) => r.rating_key).sort();

  it('ANDs the plan example: stale 180d AND added >365d AND >20 GB', () => {
    const conds: RuleCondition[] = [
      { field: 'last_watched_any', op: 'olderThanDays', value: 180 },
      { field: 'added_at', op: 'olderThanDays', value: 365 },
      { field: 'size', op: 'gtGB', value: 20 },
    ];
    // big-old: watched 300d ago (stale), old, big → match.
    // big-new: too new; small-old: too small; watched-recent: watched 5d ago;
    // other-lib: matches too (no library condition).
    expect(keys(conds)).toEqual(['big-old', 'other-lib']);
  });

  it('library + requested conditions', () => {
    expect(keys([{ field: 'library', op: 'in', value: ['2'] }])).toEqual(['other-lib']);
    replaceSeerrRequests('userA', ['small-old']);
    expect(keys([{ field: 'requested', op: 'eq', value: true }])).toEqual(['small-old']);
    expect(keys([{ field: 'library', op: 'in', value: [] }])).toEqual([]); // empty = nothing
  });

  it('FORK (3.2): matches on the household score, past the quorum', () => {
    // Two people want big-old gone (+2 +1 = 3); one person wants other-lib gone.
    applyVerdict('u1', 'big-old', 'not_interested');
    applyVerdict('u2', 'big-old', 'done_with_it');
    applyVerdict('u1', 'other-lib', 'not_interested');

    const conds: RuleCondition[] = [{ field: 'verdict_score', op: 'gte', value: 2 }];
    // other-lib scores +2 but only one person said so — the default quorum of
    // 2 holds it back. That's the guard doing its job, not a miss.
    expect(keys(conds)).toEqual(['big-old']);
    // …and a rule may lower it when a quorum will never arrive.
    expect(keys([...conds, { field: 'min_voters', op: 'gte', value: 1 }]).sort()).toEqual([
      'big-old',
      'other-lib',
    ]);
  });

  it('FORK (3.2): the quorum does not apply to a rule that reads no opinions', () => {
    // A size rule must not sit waiting for votes it never consults.
    expect(keys([{ field: 'size', op: 'gtGB', value: 20 }])).toEqual([
      'big-new',
      'big-old',
      'other-lib',
      'watched-recent',
    ]);
  });

  it('FORK (3.2): counts a verdict, and names a person who gave one', () => {
    applyVerdict('u1', 'big-old', 'not_interested');
    applyVerdict('u2', 'big-old', 'not_interested');
    applyVerdict('u1', 'other-lib', 'not_interested');
    applyVerdict('u2', 'other-lib', 'dont_care');

    expect(
      keys([{ field: 'verdict_count', op: 'gte', value: 2, verdict: 'not_interested' }])
    ).toEqual(['big-old']);
    // "u2 is done with it" — with the quorum satisfied by u1's vote too.
    expect(
      keys([{ field: 'verdict_by', op: 'eq', value: 'u2', verdict: 'not_interested' }])
    ).toEqual(['big-old']);
    expect(
      keys([{ field: 'verdict_by', op: 'eq', value: 'u2', verdict: 'dont_care' }])
    ).toEqual(['other-lib']);
  });

  it('FORK (3.2): an "OK to delete" in Browse counts as a vote', () => {
    // The requester signing off never touches `verdicts`, but it is an opinion
    // and a verdict_by rule has to see it.
    addDelete('u1', 'other-lib'); // implied done_with_it, +1
    applyVerdict('u2', 'other-lib', 'not_interested'); // +2, and makes quorum

    expect(
      keys([{ field: 'verdict_by', op: 'eq', value: 'u1', verdict: 'done_with_it' }])
    ).toEqual(['other-lib']);
    expect(keys([{ field: 'verdict_score', op: 'gte', value: 3 }])).toEqual(['other-lib']);
  });

  it('FORK (3.2): a keep still beats every vote against it', () => {
    applyVerdict('u1', 'big-old', 'not_interested');
    applyVerdict('u2', 'big-old', 'not_interested'); // +4, two voters
    const conds: RuleCondition[] = [{ field: 'verdict_score', op: 'gte', value: 1 }];
    expect(keys(conds)).toEqual(['big-old']);

    addKeep('u3', 'big-old'); // one keep outranks the whole household
    expect(keys(conds)).toEqual([]);
  });

  it('FORK (3.2): the exclusion breakdown accounts for the whole gap', () => {
    // Everything here matches the conditions; each is removed for a different
    // reason, so the four buckets must partition them with none double-counted.
    const conds: RuleCondition[] = [{ field: 'verdict_score', op: 'gte', value: 2 }];
    for (const key of ['big-old', 'big-new', 'small-old', 'watched-recent', 'other-lib']) {
      applyVerdict('u1', key, 'not_interested');
      applyVerdict('u2', key, 'not_interested'); // +4 each, two voters
    }
    addKeep('u3', 'big-old'); // kept
    tagForDeletion('big-new', 'admin', nowSec + 86400); // already tagged
    // A cancelled tag still blocks a rule — the audit row is never overwritten.
    tagForDeletion('small-old', 'admin', nowSec + 86400);
    cancelDeletionsByTagger('admin', 'changed my mind');
    removeVerdict('u2', 'watched-recent'); // now a lone voice → below quorum

    const x = ruleExclusionCounts(conds, nowSec);
    expect(x.kept).toBe(1); // big-old
    expect(x.tagged).toBe(2); // big-new (live) + small-old (cancelled)
    expect(x.quorum).toBe(1); // watched-recent
    expect(x.matched).toBe(1); // other-lib
    expect(keys(conds)).toEqual(['other-lib']);
    // The four buckets are the whole condition-matching set.
    expect(x.matched + x.kept + x.tagged + x.quorum).toBe(5);
  });

  it('FORK (3.2): no quorum in force means nothing lands in that bucket', () => {
    addKeep('u1', 'big-old');
    const x = ruleExclusionCounts([{ field: 'size', op: 'gtGB', value: 20 }], nowSec);
    expect(x.quorum).toBe(0);
    expect(x.kept).toBe(1);
    expect(x.matched).toBe(3); // big-new, watched-recent, other-lib
  });

  it('baseline: never matches kept or already-tagged items', () => {
    const conds: RuleCondition[] = [{ field: 'size', op: 'gtGB', value: 20 }];
    expect(keys(conds)).toEqual(['big-new', 'big-old', 'other-lib', 'watched-recent']);
    addKeep('userA', 'big-old'); // kept → excluded
    tagForDeletion('big-new', 'admin', nowSec + 86400); // manual tag → excluded
    expect(keys(conds)).toEqual(['other-lib', 'watched-recent']);
  });
});

describe('runRules', () => {
  beforeEach(() => {
    upsertMediaBatch([
      media('a', { sizeBytes: 30 * GB }),
      media('b', { sizeBytes: 25 * GB }),
      media('c', { sizeBytes: 1 * GB }),
    ]);
  });

  const bigRule = (enabled = true, graceDays: number | null = null) =>
    createDeletionRule({
      name: 'big stuff',
      conditions: JSON.stringify([{ field: 'size', op: 'gtGB', value: 20 }]),
      enabled,
      graceDays,
    });

  it('is inert while the Deletion master toggle is off', async () => {
    bigRule();
    const res = await runRules();
    expect(res.result).toBe(0);
    expect(res.message).toMatch(/disabled/i);
    expect(listScheduledDeletions()).toHaveLength(0);
  });

  it('tags matches as pending with the rule grace, attributed to the rule', async () => {
    setDeletionEnabled(true);
    setDeletionGraceDays(30);
    const id = bigRule(true, 7);
    const res = await runRules();
    expect(res.result).toBe(2); // a + b
    const rows = listScheduledDeletions();
    expect(rows.map((r) => r.rating_key).sort()).toEqual(['a', 'b']);
    for (const r of rows) {
      expect(r.status).toBe('pending');
      expect(r.tagged_by).toBe(`rule:${id}`);
      // 7-day rule grace, not the 30-day global default.
      expect(r.delete_after - r.tagged_at).toBeGreaterThan(6 * 86400);
      expect(r.delete_after - r.tagged_at).toBeLessThan(8 * 86400);
    }
  });

  it('disabled rules are skipped; existing tags are never overwritten', async () => {
    setDeletionEnabled(true);
    bigRule(false);
    expect((await runRules()).result).toBe(0);

    // Manual tag, then an enabled rule matching the same item: untouched.
    const manualAfter = nowSec + 99 * 86400;
    tagForDeletion('a', 'admin', manualAfter);
    bigRule(true);
    const res = await runRules();
    expect(res.result).toBe(1); // only 'b' — 'a' already tagged
    const a = listScheduledDeletions().find((r) => r.rating_key === 'a');
    expect(a?.tagged_by).toBe('admin');
    expect(a?.delete_after).toBe(manualAfter);
  });

  it("deleting a rule cancels its live tags (they mustn't outlive it)", async () => {
    setDeletionEnabled(true);
    const id = bigRule(true);
    await runRules(); // tags 'a' + 'b' as rule:<id>
    tagForDeletion('c', 'admin', nowSec + 86400); // manual tag — must survive
    const { cancelDeletionsByTagger, setDeletionResult } = await import('./queries');
    setDeletionResult('a', 'deleted', 'already purged'); // completed — must survive
    const cancelled = cancelDeletionsByTagger(`rule:${id}`, `rule ${id} deleted`);
    expect(cancelled).toBe(1); // only 'b' was still live under the rule
    const byKey = new Map(listScheduledDeletions().map((r) => [r.rating_key, r]));
    expect(byKey.get('b')?.status).toBe('cancelled');
    expect(byKey.get('a')?.status).toBe('deleted'); // audit intact
    expect(byKey.get('c')?.status).toBe('pending'); // manual tag untouched
  });

  it('an invalid stored rule is reported, not applied', async () => {
    setDeletionEnabled(true);
    createDeletionRule({ name: 'broken', conditions: '[]', enabled: true, graceDays: null });
    const res = await runRules();
    expect(res.result).toBe(0);
    expect(res.message).toMatch(/1 invalid/);
  });
});
