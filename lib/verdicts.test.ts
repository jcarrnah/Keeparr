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
  upsertUser,
  upsertWatchBatch,
  movieNightMatches,
  verdictParticipants,
  verdictConsensus,
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
  it('includes movies AND whole series, per-user, excluding swiped items', () => {
    upsertMediaBatch([media('show1', { libraryKind: 'show' })]);
    applyVerdict('userA', '1', 'not_interested');
    const a = getSwipeDeck('userA', 10).map((m) => m.rating_key).sort();
    expect(a).toEqual(['2', '3', 'show1']); // series in, swiped '1' out
    const b = getSwipeDeck('userB', 10).map((m) => m.rating_key).sort();
    expect(b).toEqual(['1', '2', '3', 'show1']); // userA's verdicts don't affect userB
    expect(countSwipeRemaining('userA')).toBe(3);
    expect(countSwipeRemaining('userB')).toBe(4);
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

describe('FORK: movie-night matches + consensus (2.4)', () => {
  const mkUser = (id: string, name: string) =>
    upsertUser({ plexUserId: id, username: name, email: null, thumb: null, isAdmin: false });

  beforeEach(() => {
    mkUser('u1', 'Johnny');
    mkUser('u2', 'Sam');
    mkUser('u3', 'Alex');
    upsertMediaBatch([media('4', { sizeBytes: 5 * GB }), media('5')]);
    // '1': Johnny+Sam want it; '2': only Sam; '4': all three want it.
    applyVerdict('u1', '1', 'want_to_watch');
    applyVerdict('u2', '1', 'want_to_watch');
    applyVerdict('u2', '2', 'want_to_watch');
    applyVerdict('u1', '4', 'want_to_watch');
    applyVerdict('u2', '4', 'want_to_watch');
    applyVerdict('u3', '4', 'want_to_watch');
    // '3': split verdicts (delete votes + an abstain).
    applyVerdict('u1', '3', 'done_with_it');
    applyVerdict('u2', '3', 'not_interested');
    applyVerdict('u3', '3', 'dont_care');
  });

  it('matches need ≥2 wanters; most-wanted first; names attached', () => {
    const rows = movieNightMatches();
    expect(rows.map((r) => r.rating_key)).toEqual(['4', '1']); // 3 wants, then 2
    expect(rows[0].want_count).toBe(3);
    expect(rows[1].wanter_names.split(',').sort()).toEqual(['Johnny', 'Sam']);
  });

  it('restricts to the chosen users', () => {
    const rows = movieNightMatches({ userIds: ['u1', 'u3'] });
    expect(rows.map((r) => r.rating_key)).toEqual(['4']); // only overlap of u1+u3
    expect(rows[0].want_count).toBe(2);
  });

  it('unwatchedOnly drops titles anyone has watched', () => {
    upsertWatchBatch([
      { plexUserId: 'u3', ratingKey: '1', plays: 1, lastWatched: nowSec - 86400 },
    ]);
    const rows = movieNightMatches({ unwatchedOnly: true });
    expect(rows.map((r) => r.rating_key)).toEqual(['4']);
  });

  it('participants = users with any verdict', () => {
    expect(verdictParticipants().map((u) => u.username)).toEqual(['Alex', 'Johnny', 'Sam']);
  });

  it('consensus rolls up names per verdict with delete votes on top', () => {
    const rows = verdictConsensus({ sort: 'votes', limit: 50, offset: 0 });
    expect(rows[0].rating_key).toBe('3'); // 2 delete votes
    expect(rows[0].delete_votes).toBe(2);
    expect(rows[0].done_names).toBe('Johnny');
    expect(rows[0].never_names).toBe('Sam');
    expect(rows[0].skip_count).toBe(1);
    expect(rows[0].kept).toBe(0);
    const four = rows.find((r) => r.rating_key === '4')!;
    expect(four.want_names?.split(',').sort()).toEqual(['Alex', 'Johnny', 'Sam']);
    expect(four.kept).toBe(1); // want_to_watch writes through to keeps
    expect(four.delete_votes).toBe(0);
  });

  it('consensus size sort puts the big title first', () => {
    const rows = verdictConsensus({ sort: 'size', limit: 50, offset: 0 });
    expect(rows[0].rating_key).toBe('4'); // 5 GB
  });
});
