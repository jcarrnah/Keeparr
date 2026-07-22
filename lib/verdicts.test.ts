/** FORK: swipe verdict write-through tests (real in-memory SQLite). */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { __setTestDbToMemory, __closeDb } from './db';
import {
  addKeep,
  applyVerdict,
  countSwipeRemaining,
  getSwipeDeck,
  getVerdict,
  isKept,
  isKeptByUser,
  isSkipped,
  listScheduledDeletions,
  removeVerdict,
  tagForDeletion,
  upsertMediaBatch,
  upsertWatchBatch,
  type UpsertMediaInput,
} from './queries';

const GB = 1024 ** 3;
const nowSec = Math.floor(Date.now() / 1000);

function media(ratingKey: string, overrides: Partial<UpsertMediaInput> = {}): UpsertMediaInput {
  return {
    ratingKey,
    sectionId: '1',
    libraryKind: 'movie',
    title: `Title ${ratingKey}`,
    year: 2020,
    thumb: null,
    sizeBytes: 1 * GB,
    addedAt: 1000,
    guidTmdb: null,
    guidTvdb: null,
    ...overrides,
  };
}

beforeEach(() => {
  __setTestDbToMemory();
  upsertMediaBatch([media('1'), media('2'), media('3')]);
});

afterAll(() => {
  __closeDb();
});

describe('FORK: applyVerdict write-through', () => {
  it('want_to_watch / loved_it imply a keep (and clear skip)', () => {
    applyVerdict('userA', '1', 'dont_care');
    expect(isSkipped('userA', '1')).toBe(true);
    expect(applyVerdict('userA', '1', 'want_to_watch')).toBe(true);
    expect(isKeptByUser('userA', '1')).toBe(true);
    expect(isSkipped('userA', '1')).toBe(false);
    expect(getVerdict('userA', '1')).toBe('want_to_watch');

    applyVerdict('userA', '2', 'loved_it');
    expect(isKeptByUser('userA', '2')).toBe(true);
  });

  it('a keep-implying verdict pauses a pending scheduled deletion', () => {
    tagForDeletion('1', 'admin', nowSec - 100);
    applyVerdict('userA', '1', 'loved_it');
    expect(listScheduledDeletions()[0].status).toBe('held');
  });

  it('dont_care maps to a skip and clears the keep', () => {
    applyVerdict('userA', '1', 'want_to_watch');
    applyVerdict('userA', '1', 'dont_care');
    expect(isKeptByUser('userA', '1')).toBe(false);
    expect(isSkipped('userA', '1')).toBe(true);
  });

  it("done_with_it / not_interested clear MY keep only (others' keeps protect)", () => {
    applyVerdict('userA', '1', 'loved_it');
    addKeep('userB', '1');
    applyVerdict('userA', '1', 'done_with_it');
    expect(isKeptByUser('userA', '1')).toBe(false);
    expect(isKept('1')).toBe(true); // userB's keep still protects
    expect(getVerdict('userA', '1')).toBe('done_with_it');
    expect(isSkipped('userA', '1')).toBe(false); // a vote, not a dismissal
  });

  it('rejects unknown/tombstoned items', () => {
    expect(applyVerdict('userA', 'nope', 'loved_it')).toBe(false);
  });
});

describe('FORK: removeVerdict (undo)', () => {
  it('reverses the write-through and rolls the item back into the deck', () => {
    applyVerdict('userA', '1', 'want_to_watch');
    expect(getSwipeDeck('userA', 10).map((m) => m.rating_key)).not.toContain('1');
    expect(removeVerdict('userA', '1')).toBe('want_to_watch');
    expect(isKeptByUser('userA', '1')).toBe(false);
    expect(getVerdict('userA', '1')).toBeNull();
    expect(getSwipeDeck('userA', 10).map((m) => m.rating_key)).toContain('1');

    applyVerdict('userA', '2', 'dont_care');
    removeVerdict('userA', '2');
    expect(isSkipped('userA', '2')).toBe(false);
  });

  it('returns null when there is nothing to undo', () => {
    expect(removeVerdict('userA', '1')).toBeNull();
  });
});

describe('FORK: swipe deck', () => {
  it('is movies-only, per-user, and excludes swiped items', () => {
    upsertMediaBatch([media('show1', { libraryKind: 'show' })]);
    applyVerdict('userA', '1', 'not_interested');
    const a = getSwipeDeck('userA', 10).map((m) => m.rating_key).sort();
    expect(a).toEqual(['2', '3']); // no show, no swiped '1'
    const b = getSwipeDeck('userB', 10).map((m) => m.rating_key).sort();
    expect(b).toEqual(['1', '2', '3']); // userA's verdicts don't affect userB
    expect(countSwipeRemaining('userA')).toBe(2);
    expect(countSwipeRemaining('userB')).toBe(3);
  });

  it('honors the watch-list modes (e.g. never played)', () => {
    upsertWatchBatch([
      { plexUserId: 'userB', ratingKey: '2', plays: 1, lastWatched: nowSec - 86400 },
    ]);
    const keys = getSwipeDeck('userA', 10, { watchMode: 'never_played' })
      .map((m) => m.rating_key)
      .sort();
    expect(keys).toEqual(['1', '3']);
    expect(countSwipeRemaining('userA', { watchMode: 'never_played' })).toBe(2);
  });

  it('feed eligibility still applies (kept-by-anyone is out of the deck)', () => {
    addKeep('userB', '3');
    expect(getSwipeDeck('userA', 10).map((m) => m.rating_key).sort()).toEqual(['1', '2']);
  });
});
