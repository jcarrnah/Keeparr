/** FORK: deletion-rules engine tests (real in-memory SQLite, no mocks). */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { __setTestDbToMemory, __closeDb } from './db';
import {
  addKeep,
  createDeletionRule,
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
import type { RuleCondition } from './types';

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
    ];
    expect(parseRuleConditions(JSON.stringify(conds))).toEqual(conds);
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
