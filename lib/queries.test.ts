import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { __setTestDbToMemory, __closeDb } from './db';
import {
  addKeep,
  applySkipBatch,
  applyKeep,
  applySkip,
  applyDelete,
  getActiveMediaItem,
  getMediaItem,
  addSkip,
  removeSkip,
  isSkipped,
  addDelete,
  removeDelete,
  isMarkedForDelete,
  isRequestedByUser,
  markedForDeleteItems,
  markedForDeleteSummary,
  countFeedRemaining,
  getFeed,
  isKept,
  isKeptByUser,
  largestItems,
  neverWatchedItems,
  librarySummary,
  replaceArrItems,
  clearArrItems,
  replaceArrUnmatched,
  getArrUnmatched,
  clearArrUnmatched,
  mediaMissingExternalIds,
  arrMatchedCount,
  arrQualitySummary,
  unmatchedMediaSummary,
  arrFacets,
  ratingKeysByGuid,
  type ArrItemInput,
  type LibraryQuery,
  listUsers,
  queryLibrary,
  searchMedia,
  reclaimableItems,
  reclaimableTotalBytes,
  libraryStats,
  removeKeep,
  setUserAdmin,
  upsertMediaBatch,
  upsertUser,
  getUser,
  tombstoneStale,
  getJobState,
  setJobState,
  isJobRunning,
  getAllJobState,
  resetInterruptedJobs,
  setUserEnabled,
  recordJobRun,
  recentJobRuns,
  logEvent,
  recentLogs,
  clearLogs,
  replaceSeerrRequests,
  clearSeerrRequests,
  seerrRequestKeys,
  upsertWatchBatch,
  clearWatchHistory,
  existingShowSizes,
  showRatingKeys,
  updateItemSize,
  type UpsertMediaInput,
  type FeedWatchMode,
  tagForDeletion,
  cancelDeletion,
  listScheduledDeletions,
  refreshDeletionHolds,
  dueDeletions,
  setDeletionResult,
  arrMatchForItem,
} from './queries';

const GB = 1024 ** 3;

function media(
  ratingKey: string,
  overrides: Partial<UpsertMediaInput> = {}
): UpsertMediaInput {
  return {
    ratingKey,
    sectionId: '1',
    libraryKind: 'movie',
    title: `Title ${ratingKey}`,
    year: 2020,
    thumb: `/library/metadata/${ratingKey}/thumb`,
    sizeBytes: 1 * GB,
    addedAt: 1000,
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

function user(plexUserId: string, isAdmin = false) {
  upsertUser({
    plexUserId,
    username: `user${plexUserId}`,
    email: `${plexUserId}@example.com`,
    thumb: null,
    isAdmin,
  });
}

describe('users: listUsers + setUserAdmin', () => {
  it('lists all users, admins first', () => {
    user('regular');
    user('owner', true);
    const rows = listUsers();
    expect(rows.map((r) => r.plexUserId)).toEqual(['owner', 'regular']);
    expect(rows[0].isAdmin).toBe(true);
    expect(rows[1].isAdmin).toBe(false);
  });

  it('setUserAdmin promotes a regular user', () => {
    user('regular');
    expect(getUser('regular')?.isAdmin).toBe(false);
    setUserAdmin('regular', true);
    expect(getUser('regular')?.isAdmin).toBe(true);
  });

  it('setUserAdmin demotes an admin (bypasses the one-way upsert MAX)', () => {
    user('admin', true);
    // upsertUser can never lower is_admin...
    upsertUser({
      plexUserId: 'admin',
      username: 'admin',
      email: null,
      thumb: null,
      isAdmin: false,
    });
    expect(getUser('admin')?.isAdmin).toBe(true);
    // ...but setUserAdmin can.
    setUserAdmin('admin', false);
    expect(getUser('admin')?.isAdmin).toBe(false);
  });
});

describe('users: enabled flag', () => {
  function mkUser(id: string, enabled?: boolean) {
    upsertUser({
      plexUserId: id,
      username: id,
      email: null,
      thumb: null,
      isAdmin: false,
      enabled,
    });
  }

  it('defaults to enabled and round-trips via setUserEnabled', () => {
    mkUser('u');
    expect(getUser('u')?.enabled).toBe(true);
    setUserEnabled('u', false);
    expect(getUser('u')?.enabled).toBe(false);
  });

  it('preserves enabled across a re-upsert (e.g. next login)', () => {
    mkUser('u');
    setUserEnabled('u', false);
    mkUser('u'); // simulates a subsequent login upsert
    expect(getUser('u')?.enabled).toBe(false);
  });

  it('can be imported as disabled', () => {
    mkUser('imported', false);
    expect(getUser('imported')?.enabled).toBe(false);
  });
});

describe('job_runs activity log', () => {
  function run(jobId: string, startedAt: number, status = 'ok') {
    recordJobRun({
      jobId,
      startedAt,
      endedAt: startedAt + 1,
      status,
      message: `${jobId} ${status}`,
      durationMs: 1000,
      result: 1,
    });
  }

  it('returns most-recent first', () => {
    run('library', 100);
    run('sizes', 300);
    run('watch', 200);
    const rows = recentJobRuns(10);
    expect(rows.map((r) => r.jobId)).toEqual(['sizes', 'watch', 'library']);
  });

  it('prunes to the most recent 100', () => {
    for (let i = 0; i < 110; i++) run('library', i);
    const rows = recentJobRuns(1000);
    expect(rows.length).toBe(100);
    expect(rows[0].startedAt).toBe(109); // newest kept
  });
});

describe('logs', () => {
  it('appends, filters by level, and clears', () => {
    logEvent('info', 'job:library', 'ok');
    logEvent('error', 'job:sizes', 'boom');
    expect(recentLogs().length).toBe(2);
    const errs = recentLogs({ level: 'error' });
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('boom');
    clearLogs();
    expect(recentLogs()).toHaveLength(0);
  });

  it('keyword search matches message OR source, case-insensitively', () => {
    logEvent('info', 'job:library', 'Synced 300 items');
    logEvent('error', 'job:arr', 'Sonarr unreachable');
    logEvent('warn', 'backup', 'pruned 2 old');
    expect(recentLogs({ q: 'SYNCED' })).toHaveLength(1); // message, wrong case
    expect(recentLogs({ q: 'job:' })).toHaveLength(2); // source
    expect(recentLogs({ q: 'sonarr' }).map((l) => l.level)).toEqual(['error']);
    expect(recentLogs({ q: 'nope' })).toHaveLength(0);
    // combines with the level filter
    expect(recentLogs({ q: 'job:', level: 'error' })).toHaveLength(1);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) logEvent('info', 's', `m${i}`);
    expect(recentLogs({ limit: 2 })).toHaveLength(2);
    expect(recentLogs({ limit: 2 })[0].message).toBe('m4'); // newest first
  });
});

describe('cache clears', () => {
  it('clears seerr requests + watch history', () => {
    replaceSeerrRequests('userA', ['1', '2']);
    upsertWatchBatch([
      { plexUserId: 'userA', ratingKey: '1', plays: 1, lastWatched: 1 },
    ]);
    expect(seerrRequestKeys('userA')).toHaveLength(2);
    expect(clearSeerrRequests()).toBe(2);
    expect(seerrRequestKeys('userA')).toHaveLength(0);
    expect(clearWatchHistory()).toBe(1);
  });
});

describe('job state', () => {
  it('defaults to never for an unknown job', () => {
    const s = getJobState('library');
    expect(s.lastStatus).toBe('never');
    expect(s.lastRun).toBeNull();
  });

  it('upserts and merges partial updates', () => {
    setJobState('library', { lastStatus: 'running', lastMessage: 'go' });
    expect(isJobRunning('library')).toBe(true);
    setJobState('library', { lastStatus: 'ok', lastRun: 123, lastResult: 7 });
    const s = getJobState('library');
    expect(s.lastStatus).toBe('ok');
    expect(s.lastRun).toBe(123);
    expect(s.lastResult).toBe(7);
    expect(s.lastMessage).toBe('go'); // preserved across the partial update
    expect(isJobRunning('library')).toBe(false);
  });

  it('lists all job rows', () => {
    setJobState('library', { lastStatus: 'ok' });
    setJobState('requests', { lastStatus: 'error' });
    expect(getAllJobState().map((j) => j.jobId).sort()).toEqual([
      'library',
      'requests',
    ]);
  });

  it('resetInterruptedJobs flips stuck running rows to error, others untouched', () => {
    setJobState('sizes', { lastStatus: 'running', lastRun: 50, lastMessage: 'Running…' });
    setJobState('library', { lastStatus: 'ok', lastRun: 99 });
    expect(resetInterruptedJobs()).toBe(1);
    const s = getJobState('sizes');
    expect(s.lastStatus).toBe('error');
    expect(s.lastMessage).toContain('Interrupted');
    expect(s.lastRun).toBe(50); // preserved so the schedule re-fires normally
    expect(isJobRunning('sizes')).toBe(false);
    expect(getJobState('library').lastStatus).toBe('ok');
  });
});

describe('seerr request cache', () => {
  it('replaces a user\'s keys atomically and is per-user', () => {
    replaceSeerrRequests('userA', ['1', '2', '3']);
    replaceSeerrRequests('userB', ['9']);
    expect(seerrRequestKeys('userA').sort()).toEqual(['1', '2', '3']);
    expect(seerrRequestKeys('userB')).toEqual(['9']);
    // Replace fully swaps the set.
    replaceSeerrRequests('userA', ['4']);
    expect(seerrRequestKeys('userA')).toEqual(['4']);
    expect(seerrRequestKeys('userB')).toEqual(['9']); // untouched
  });
});

describe('size-split helpers', () => {
  beforeEach(() =>
    upsertMediaBatch([
      media('mv', { libraryKind: 'movie', sizeBytes: 1 * GB }),
      media('sh1', { libraryKind: 'show', sizeBytes: 2 * GB }),
      media('sh2', { libraryKind: 'show', sizeBytes: 3 * GB }),
    ])
  );

  it('existingShowSizes returns only shows with their current sizes', () => {
    const m = existingShowSizes();
    expect(m.get('sh1')).toBe(2 * GB);
    expect(m.get('sh2')).toBe(3 * GB);
    expect(m.has('mv')).toBe(false);
  });

  it('showRatingKeys + updateItemSize recompute sizes', () => {
    expect(showRatingKeys().sort()).toEqual(['sh1', 'sh2']);
    updateItemSize('sh1', 10 * GB);
    expect(existingShowSizes().get('sh1')).toBe(10 * GB);
  });
});

describe('feed by library + weighting', () => {
  beforeEach(() => {
    upsertMediaBatch([
      media('mov1', { libraryKind: 'movie', sectionId: '1' }),
      media('show1', { libraryKind: 'show', sectionId: '2' }),
      media('show2', { libraryKind: 'show', sectionId: '2' }),
      media('show3', { libraryKind: 'show', sectionId: '3' }),
    ]);
  });

  it('limits the feed to a single Plex library', () => {
    const keys = getFeed('userA', 10, { sectionId: '2' })
      .map((r) => r.rating_key)
      .sort();
    expect(keys).toEqual(['show1', 'show2']);
  });

  it('the mixed feed always includes a movie via the reserve quota', () => {
    // The single movie must always appear given the reserved movie slots.
    for (let i = 0; i < 8; i++) {
      const keys = getFeed('userA', 4).map((r) => r.rating_key);
      expect(keys).toContain('mov1');
    }
  });

  it('countFeedRemaining respects the section filter', () => {
    expect(countFeedRemaining('userA', { sectionId: '1' })).toBe(1);
    expect(countFeedRemaining('userA', { sectionId: '2' })).toBe(2);
    expect(countFeedRemaining('userA')).toBe(4);
  });
});

describe('per-item skips (don\'t care)', () => {
  beforeEach(() => upsertMediaBatch([media('1'), media('2')]));

  it('addSkip is idempotent per user', () => {
    expect(addSkip('userA', '1')).toBe(true);
    expect(addSkip('userA', '1')).toBe(false); // already there
    expect(isSkipped('userA', '1')).toBe(true);
  });

  it('removeSkip clears only when present', () => {
    expect(removeSkip('userA', '1')).toBe(false); // nothing to remove
    addSkip('userA', '1');
    expect(removeSkip('userA', '1')).toBe(true);
    expect(isSkipped('userA', '1')).toBe(false);
  });

  it('is scoped per user', () => {
    addSkip('userA', '1');
    expect(isSkipped('userA', '1')).toBe(true);
    expect(isSkipped('userB', '1')).toBe(false);
  });

  it('excludes the item from that user\'s feed only', () => {
    addSkip('userA', '1');
    const a = getFeed('userA', 10).map((r) => r.rating_key);
    const b = getFeed('userB', 10).map((r) => r.rating_key);
    expect(a).not.toContain('1');
    expect(b).toContain('1');
  });
});

describe('media upsert + tombstone', () => {
  it('inserts then updates on conflict', () => {
    upsertMediaBatch([media('1', { sizeBytes: 1 * GB })]);
    upsertMediaBatch([media('1', { sizeBytes: 5 * GB, title: 'Renamed' })]);
    const stats = libraryStats();
    expect(stats.totalItems).toBe(1);
    expect(stats.totalBytes).toBe(5 * GB);
  });

  it('tombstones items not seen in the latest sync', () => {
    // First sync at t=1000 touches both items.
    upsertMediaBatch([media('1'), media('2')], 1000);
    // Second sync at t=2000 only re-touches item 1.
    upsertMediaBatch([media('1')], 2000);
    const removed = tombstoneStale(2000); // anything older than this sync
    expect(removed).toBe(1); // item 2 tombstoned
    expect(libraryStats().totalItems).toBe(1);
  });

  it('excluded sections are shielded from the tombstone sweep', () => {
    upsertMediaBatch(
      [media('1', { sectionId: '1' }), media('2', { sectionId: '2' })],
      1000
    );
    // Neither item was re-touched, but section 2's scan came back empty-but-200
    // — its rows must survive the sweep.
    const removed = tombstoneStale(2000, ['2']);
    expect(removed).toBe(1); // only section 1's stale item
    expect(libraryStats().totalItems).toBe(1); // section 2's row survived
  });
});

describe('keeps are per-user (protected if anyone keeps)', () => {
  it('a user keeps once; their second keep is a no-op', () => {
    upsertMediaBatch([media('1')]);
    expect(addKeep('userA', '1')).toBe(true);
    expect(addKeep('userA', '1')).toBe(false);
    expect(isKept('1')).toBe(true);
    expect(isKeptByUser('userA', '1')).toBe(true);
  });

  it('two users keep the same item independently', () => {
    upsertMediaBatch([media('1')]);
    expect(addKeep('userA', '1')).toBe(true);
    expect(addKeep('userB', '1')).toBe(true);
    expect(isKeptByUser('userA', '1')).toBe(true);
    expect(isKeptByUser('userB', '1')).toBe(true);
  });

  it("removeKeep only removes the caller's keep; item stays protected", () => {
    upsertMediaBatch([media('1')]);
    addKeep('userA', '1');
    addKeep('userB', '1');
    expect(removeKeep('userA', '1')).toBe(true);
    expect(isKeptByUser('userA', '1')).toBe(false);
    expect(isKeptByUser('userB', '1')).toBe(true);
    expect(isKept('1')).toBe(true); // still kept by B
    expect(removeKeep('userB', '1')).toBe(true);
    expect(isKept('1')).toBe(false); // now kept by nobody
  });
});

describe('feed excludes kept + per-user skipped', () => {
  beforeEach(() => {
    upsertMediaBatch([media('1'), media('2'), media('3'), media('4')]);
  });

  it('excludes globally-kept items for everyone', () => {
    addKeep('userA', '1');
    const feedB = getFeed('userB', 10).map((m) => m.rating_key);
    expect(feedB).not.toContain('1');
    expect(feedB.sort()).toEqual(['2', '3', '4']);
  });

  it('skips are per-user only', () => {
    applySkipBatch('userA', ['2', '3']);
    const feedA = getFeed('userA', 10).map((m) => m.rating_key).sort();
    const feedB = getFeed('userB', 10).map((m) => m.rating_key).sort();
    expect(feedA).toEqual(['1', '4']); // A skipped 2 & 3
    expect(feedB).toEqual(['1', '2', '3', '4']); // B unaffected
  });

  it('countFeedRemaining reflects keeps + skips', () => {
    addKeep('userA', '1');
    applySkipBatch('userA', ['2']);
    expect(countFeedRemaining('userA')).toBe(2); // 3 & 4 remain
    expect(countFeedRemaining('userB')).toBe(3); // only keep removes 1
  });

  it('respects the limit', () => {
    expect(getFeed('userA', 2)).toHaveLength(2);
  });
});

describe('feed watch-history lists (watchMode)', () => {
  const dago = (d: number) => Math.floor(Date.now() / 1000) - d * 86400;

  beforeEach(() => {
    upsertMediaBatch([
      media('1'),
      media('2'),
      media('3'),
      media('4'),
      media('5', { sectionId: '2' }),
    ]);
    upsertWatchBatch([
      { plexUserId: 'userA', ratingKey: '1', plays: 2, lastWatched: dago(10) }, // recent, by me
      { plexUserId: 'userA', ratingKey: '2', plays: 1, lastWatched: dago(200) }, // stale, by me
      { plexUserId: 'userB', ratingKey: '3', plays: 1, lastWatched: dago(5) }, // recent, by someone else
      { plexUserId: 'userB', ratingKey: '5', plays: 1, lastWatched: dago(100) }, // stale, by someone else
      // '4' — watched by nobody
    ]);
  });

  const feedKeys = (watchMode: FeedWatchMode) =>
    getFeed('userA', 10, { watchMode })
      .map((m) => m.rating_key)
      .sort();

  it('never_played = never watched by ANYONE', () => {
    expect(feedKeys('never_played')).toEqual(['4']);
    expect(countFeedRemaining('userA', { watchMode: 'never_played' })).toBe(1);
  });

  it('stale_90 = no watch by anyone in 90d (includes never-played)', () => {
    expect(feedKeys('stale_90')).toEqual(['2', '4', '5']);
    expect(countFeedRemaining('userA', { watchMode: 'stale_90' })).toBe(3);
  });

  it('recent_30 = watched by someone within 30d', () => {
    expect(feedKeys('recent_30')).toEqual(['1', '3']);
    expect(countFeedRemaining('userA', { watchMode: 'recent_30' })).toBe(2);
  });

  it("my_unwatched = THIS user hasn't watched it (others may have)", () => {
    expect(feedKeys('my_unwatched')).toEqual(['3', '4', '5']);
    // userB's own unwatched list differs — it's per-user.
    const b = getFeed('userB', 10, { watchMode: 'my_unwatched' })
      .map((m) => m.rating_key)
      .sort();
    expect(b).toEqual(['1', '2', '4']);
  });

  it('combines with the section filter', () => {
    const keys = getFeed('userA', 10, { sectionId: '2', watchMode: 'my_unwatched' })
      .map((m) => m.rating_key);
    expect(keys).toEqual(['5']);
    expect(
      countFeedRemaining('userA', { sectionId: '2', watchMode: 'stale_90' })
    ).toBe(1);
    expect(
      countFeedRemaining('userA', { sectionId: '2', watchMode: 'recent_30' })
    ).toBe(0);
  });

  it('feed eligibility (keeps/skips) still applies inside a list', () => {
    addKeep('userB', '4');
    expect(feedKeys('never_played')).toEqual([]);
    applySkipBatch('userA', ['2']);
    // '2' skipped by me, '4' kept by userB — only '5' is left in the stale list.
    expect(feedKeys('stale_90')).toEqual(['5']);
  });
});

describe('reclaimable + library views', () => {
  beforeEach(() => {
    upsertMediaBatch([
      media('1', { sizeBytes: 10 * GB }),
      media('2', { sizeBytes: 5 * GB }),
      media('3', { sizeBytes: 1 * GB }),
    ]);
  });

  it('reclaimable excludes kept and sorts by size desc', () => {
    addKeep('userA', '1'); // largest is kept
    const items = reclaimableItems(10, 0).map((m) => m.rating_key);
    expect(items).toEqual(['2', '3']);
    expect(reclaimableTotalBytes()).toBe(6 * GB);
  });

  it('largestItems includes kept flags and full ordering', () => {
    addKeep('userA', '2');
    addKeep('userB', '3');
    const items = largestItems(10, 0, 'userA');
    expect(items.map((m) => m.rating_key)).toEqual(['1', '2', '3']);
    expect(items.find((m) => m.rating_key === '2')?.kept).toBe(1);
    expect(items.find((m) => m.rating_key === '2')?.kept_by_me).toBe(1);
    // kept by another user → protected but not mine
    expect(items.find((m) => m.rating_key === '3')?.kept).toBe(1);
    expect(items.find((m) => m.rating_key === '3')?.kept_by_me).toBe(0);
    expect(items.find((m) => m.rating_key === '1')?.kept).toBe(0);
  });

  it('queryLibrary search + hideKept', () => {
    addKeep('userA', '1');
    const kept = queryLibrary({ plexUserId: 'userA', limit: 10, offset: 0 });
    expect(kept).toHaveLength(3);
    expect(kept.find((m) => m.rating_key === '1')?.kept_by_me).toBe(1);
    const hidden = queryLibrary({
      plexUserId: 'userA',
      limit: 10,
      offset: 0,
      hideKept: true,
    });
    expect(hidden.map((m) => m.rating_key)).toEqual(['2', '3']);
    const searched = queryLibrary({
      plexUserId: 'userA',
      limit: 10,
      offset: 0,
      search: 'Title 2',
    });
    expect(searched.map((m) => m.rating_key)).toEqual(['2']);
  });

  it('queryLibrary filters by skip + year sort + requestedKeys', () => {
    addSkip('userA', '2');
    // skip filters are per-user
    const skipped = queryLibrary({
      plexUserId: 'userA',
      limit: 10,
      offset: 0,
      skipFilter: 'skipped',
    });
    expect(skipped.map((m) => m.rating_key)).toEqual(['2']);
    expect(skipped[0].skipped).toBe(1);
    const otherUser = queryLibrary({
      plexUserId: 'userB',
      limit: 10,
      offset: 0,
      skipFilter: 'skipped',
    });
    expect(otherUser).toHaveLength(0);

    // year sort, ascending
    const byYearAsc = queryLibrary({
      plexUserId: 'userA',
      limit: 10,
      offset: 0,
      sort: 'year',
      dir: 'asc',
    });
    const years = byYearAsc.map((m) => m.year);
    expect(years).toEqual([...years].sort((a, b) => (a ?? 0) - (b ?? 0)));

    // requestedKeys restricts; empty = nothing
    const restricted = queryLibrary({
      plexUserId: 'userA',
      limit: 10,
      offset: 0,
      requestedKeys: ['3'],
    });
    expect(restricted.map((m) => m.rating_key)).toEqual(['3']);
    const none = queryLibrary({
      plexUserId: 'userA',
      limit: 10,
      offset: 0,
      requestedKeys: [],
    });
    expect(none).toHaveLength(0);
  });

  it('libraryStats totals (a multi-keeper item counts once)', () => {
    addKeep('userA', '1');
    addKeep('userB', '1'); // same item, second keeper — must not double-count
    const s = libraryStats();
    expect(s.totalItems).toBe(3);
    expect(s.totalBytes).toBe(16 * GB);
    expect(s.keptItems).toBe(1);
    expect(s.keptBytes).toBe(10 * GB);
    expect(s.reclaimableBytes).toBe(6 * GB);
  });

  it('librarySummary partitions bytes into kept / dontcare / undecided per user', () => {
    // items 1 (10GB), 2 (5GB), 3 (1GB), all in section '1'.
    addKeep('userB', '1'); // protected by someone else (not me)
    addKeep('userA', '2'); // protected by me
    addSkip('userA', '3'); // I don't care about the smallest

    const [row] = librarySummary('userA');
    expect(row.section_id).toBe('1');
    expect(row.items).toBe(3);
    expect(row.bytes).toBe(16 * GB);

    // kept = protected by anyone (items 1 and 2)
    expect(row.kept_items).toBe(2);
    expect(row.kept_bytes).toBe(15 * GB);
    // of which only item 2 is my own keep
    expect(row.kept_by_me_items).toBe(1);
    expect(row.kept_by_me_bytes).toBe(5 * GB);
    // don't care = not protected AND skipped by me (item 3)
    expect(row.dontcare_items).toBe(1);
    expect(row.dontcare_bytes).toBe(1 * GB);
    // undecided = not protected AND not skipped (none left here)
    expect(row.undecided_items).toBe(0);
    expect(row.undecided_bytes).toBe(0);

    // buckets partition the total exactly
    expect(row.kept_bytes + row.dontcare_bytes + row.undecided_bytes).toBe(
      row.bytes
    );
  });
});

describe('watch filters + never-watched', () => {
  const dago = (d: number) => Math.floor(Date.now() / 1000) - d * 86400;

  beforeEach(() => {
    upsertMediaBatch([
      media('1'),
      media('2'),
      media('3'),
      media('4'),
      media('5', { sizeBytes: 2 * GB }),
    ]);
    upsertWatchBatch([
      { plexUserId: 'userA', ratingKey: '1', plays: 3, lastWatched: dago(10) }, // recent
      { plexUserId: 'userA', ratingKey: '2', plays: 1, lastWatched: dago(75) }, // ≤90 only
      { plexUserId: 'userA', ratingKey: '3', plays: 1, lastWatched: dago(210) }, // stale
      { plexUserId: 'userB', ratingKey: '4', plays: 9, lastWatched: dago(5) }, // someone else
      // '5' — watched by nobody
    ]);
  });

  const keys = (watchFilter: Parameters<typeof queryLibrary>[0]['watchFilter']) =>
    queryLibrary({ plexUserId: 'userA', limit: 100, offset: 0, watchFilter })
      .map((r) => r.rating_key)
      .sort();

  it('watched / unwatched are per-user', () => {
    expect(keys('watched')).toEqual(['1', '2', '3']); // userA's plays
    expect(keys('unwatched')).toEqual(['4', '5']); // '4' is userB's, not userA's
  });

  it('recency windows use last_watched', () => {
    expect(keys('recent30')).toEqual(['1']);
    expect(keys('recent60')).toEqual(['1']);
    expect(keys('recent90')).toEqual(['1', '2']);
  });

  it('stale90 = never-watched-by-you OR last watched 90d+ ago', () => {
    expect(keys('stale90')).toEqual(['3', '4', '5']);
  });

  it('queryLibrary returns a per-user watched flag', () => {
    const rows = queryLibrary({ plexUserId: 'userA', limit: 100, offset: 0 });
    expect(rows.find((r) => r.rating_key === '1')?.watched).toBe(1);
    expect(rows.find((r) => r.rating_key === '4')?.watched).toBe(0); // userB's, not userA's
    expect(rows.find((r) => r.rating_key === '5')?.watched).toBe(0);
  });

  it('searchMedia exposes the watched flag', () => {
    const rows = searchMedia({ query: 'Title', plexUserId: 'userA', limit: 100, offset: 0 });
    expect(rows.find((r) => r.rating_key === '2')?.watched).toBe(1);
    expect(rows.find((r) => r.rating_key === '5')?.watched).toBe(0);
  });

  it('librarySummary counts "never watched by anyone" (only item 5)', () => {
    const [row] = librarySummary('userA');
    expect(row.unwatched_items).toBe(1); // only '5' — '4' is watched by userB
    expect(row.unwatched_bytes).toBe(2 * GB);
  });

  it('unwatchedAny = never watched by ANYONE (server-wide, not per-user)', () => {
    // '4' is watched by userB, so it's excluded even though userA never saw it.
    expect(keys('unwatchedAny')).toEqual(['5']);
    // Contrast: per-user "unwatched" still includes '4' for userA.
    expect(keys('unwatched')).toEqual(['4', '5']);
  });

  it('neverWatchedItems returns server-wide unwatched, largest first', () => {
    const rows = neverWatchedItems(100, 0, 'userA');
    expect(rows.map((r) => r.rating_key)).toEqual(['5']); // only nobody-watched item
    expect(rows[0].size_bytes).toBe(2 * GB);
  });

  it('neverWatchedItems carries kept flags for this user', () => {
    addKeep('userA', '5');
    const [row] = neverWatchedItems(100, 0, 'userA');
    expect(row.kept).toBe(1);
    expect(row.kept_by_me).toBe(1);
  });
});

describe('librarySummary never-watched split by keep bucket', () => {
  beforeEach(() => {
    upsertMediaBatch([
      media('1', { sizeBytes: 1 * GB }), // kept by me, never watched
      media('2', { sizeBytes: 2 * GB }), // kept by other, never watched
      media('3', { sizeBytes: 4 * GB }), // I don't care, never watched
      media('4', { sizeBytes: 8 * GB }), // undecided, never watched
      media('5', { sizeBytes: 16 * GB }), // undecided but WATCHED → excluded
    ]);
    addKeep('me', '1');
    addKeep('other', '2');
    addSkip('me', '3');
    upsertWatchBatch([
      { plexUserId: 'someone', ratingKey: '5', plays: 1, lastWatched: 1000 },
    ]);
  });

  it('splits never-watched bytes across keep buckets (they sum to the total)', () => {
    const [r] = librarySummary('me');
    expect(r.unwatched_bytes).toBe((1 + 2 + 4 + 8) * GB); // '5' watched → excluded
    expect(r.unwatched_kept_by_me_bytes).toBe(1 * GB);
    expect(r.unwatched_kept_bytes).toBe((1 + 2) * GB); // protected: mine + other's
    expect(r.unwatched_dontcare_bytes).toBe(4 * GB);
    expect(r.unwatched_undecided_bytes).toBe(8 * GB);
    const keptOther = r.unwatched_kept_bytes - r.unwatched_kept_by_me_bytes;
    expect(
      r.unwatched_kept_by_me_bytes +
        keptOther +
        r.unwatched_dontcare_bytes +
        r.unwatched_undecided_bytes
    ).toBe(r.unwatched_bytes);
  });
});

describe('arr_items (Sonarr/Radarr filters in queryLibrary)', () => {
  const arr = (over: Partial<ArrItemInput>): ArrItemInput => ({
    ratingKey: '1',
    source: 'radarr',
    instanceId: 'r1',
    instanceName: 'Radarr',
    arrId: 1,
    monitored: true,
    status: 'released',
    quality: 'Bluray-1080p',
    qualityKind: 'file',
    rootFolder: '/m',
    arrSizeBytes: 1 * GB,
    tags: [],
    ...over,
  });

  beforeEach(() => {
    upsertMediaBatch([
      media('1', { sizeBytes: 5 * GB }),
      media('2', { sizeBytes: 3 * GB }),
      media('3', { sizeBytes: 1 * GB }), // no arr row → excluded from the view
    ]);
    replaceArrItems([
      // arr size matches Plex (5 GB) → no mismatch.
      arr({ ratingKey: '1', source: 'radarr', quality: 'Bluray-2160p', tags: ['Bounty'], arrSizeBytes: 5 * GB }),
      // arr size 1 GB vs Plex 3 GB → flagged as a size mismatch.
      arr({
        ratingKey: '2',
        source: 'sonarr',
        instanceId: 's1',
        instanceName: 'Sonarr',
        quality: 'Ultra-HD',
        qualityKind: 'profile',
        tags: ['Anime'],
        monitored: false,
        status: 'ended',
        arrSizeBytes: 1 * GB,
      }),
    ]);
  });

  const keys = (q: Partial<LibraryQuery>) =>
    queryLibrary({ plexUserId: 'u', limit: 100, offset: 0, ...q })
      .map((r) => r.rating_key)
      .sort();

  it('Browse returns ALL media; arr fields null on unmatched (item 3)', () => {
    expect(keys({})).toEqual(['1', '2', '3']);
    const rows = queryLibrary({ plexUserId: 'u', limit: 100, offset: 0 });
    expect(rows.find((r) => r.rating_key === '1')?.arr_quality).toBe('Bluray-2160p');
    expect(rows.find((r) => r.rating_key === '1')?.arr_source).toBe('radarr');
    expect(rows.find((r) => r.rating_key === '3')?.arr_quality).toBeNull();
    expect(rows.find((r) => r.rating_key === '3')?.arr_source).toBeNull();
  });

  it('source filter restricts to that app (multi = any of)', () => {
    expect(keys({ sources: ['radarr'] })).toEqual(['1']);
    expect(keys({ sources: ['sonarr'] })).toEqual(['2']);
    expect(keys({ sources: ['sonarr', 'radarr'] })).toEqual(['1', '2']);
  });

  it('tag filter (json_each, any of)', () => {
    expect(keys({ tags: ['Anime'] })).toEqual(['2']);
    expect(keys({ tags: ['Bounty'] })).toEqual(['1']);
    expect(keys({ tags: ['Anime', 'Bounty'] })).toEqual(['1', '2']);
  });

  it('quality (any of) + monitored filters', () => {
    expect(keys({ qualities: ['Ultra-HD'] })).toEqual(['2']);
    expect(keys({ qualities: ['Ultra-HD', 'Bluray-2160p'] })).toEqual(['1', '2']);
    expect(keys({ monitored: ['unmonitored'] })).toEqual(['2']);
    expect(keys({ monitored: ['monitored'] })).toEqual(['1']);
    expect(keys({ monitored: ['monitored', 'unmonitored'] })).toEqual(['1', '2', '3']); // both = no filter → all media
  });

  it('match filter (in / not in *arr)', () => {
    expect(keys({ matchFilter: 'matched' })).toEqual(['1', '2']);
    expect(keys({ matchFilter: 'unmatched' })).toEqual(['3']); // no arr row
  });

  it('status filter (any of)', () => {
    expect(keys({ statuses: ['ended'] })).toEqual(['2']);
    expect(keys({ statuses: ['released'] })).toEqual(['1']);
  });

  it('size-mismatch filter (Plex vs arr divergence)', () => {
    expect(keys({ sizeMismatch: true })).toEqual(['2']); // 1 GB arr vs 3 GB Plex
  });

  it('sortable by an arr column (quality), arr-null rows last', () => {
    const order = (dir: 'asc' | 'desc') =>
      queryLibrary({ plexUserId: 'u', limit: 100, offset: 0, sort: 'quality', dir }).map(
        (r) => r.rating_key
      );
    expect(order('asc')).toEqual(['1', '2', '3']); // Bluray-2160p, Ultra-HD, (null)
    expect(order('desc')).toEqual(['2', '1', '3']); // Ultra-HD, Bluray-2160p, (null last)
  });

  it('arrFacets returns distinct instances / tags / qualities', () => {
    const f = arrFacets();
    expect(f.tags.sort()).toEqual(['Anime', 'Bounty']);
    expect(f.qualities.sort()).toEqual(['Bluray-2160p', 'Ultra-HD']);
    expect(f.instances.map((i) => i.id).sort()).toEqual(['r1', 's1']);
  });

  it('replaceArrItems replaces all; clearArrItems empties (media unaffected)', () => {
    replaceArrItems([arr({ ratingKey: '3', source: 'radarr' })]);
    expect(keys({ sources: ['radarr'] })).toEqual(['3']);
    clearArrItems();
    expect(keys({ sources: ['radarr'] })).toEqual([]);
    expect(keys({})).toEqual(['1', '2', '3']); // all media still there
  });

  it('replaceArrItems preserves rows of instances that failed this run', () => {
    // Radarr (r1) succeeded with a fresh row for item 3; Sonarr (s1) failed —
    // its item-2 row must survive, r1's stale item-1 row must not.
    replaceArrItems([arr({ ratingKey: '3', source: 'radarr' })], ['s1']);
    const rows = queryLibrary({ plexUserId: 'u', limit: 100, offset: 0 });
    expect(rows.find((r) => r.rating_key === '1')?.arr_source).toBeNull(); // wiped
    expect(rows.find((r) => r.rating_key === '2')?.arr_source).toBe('sonarr'); // kept
    expect(rows.find((r) => r.rating_key === '3')?.arr_source).toBe('radarr'); // fresh
  });
});

describe('arr match health + quality summary', () => {
  const arrItem = (over: Partial<ArrItemInput>): ArrItemInput => ({
    ratingKey: 's1',
    source: 'sonarr',
    instanceId: 'x',
    instanceName: 'S',
    arrId: 1,
    monitored: true,
    status: 'ended',
    quality: 'HD-1080p',
    qualityKind: 'profile',
    rootFolder: '/tv',
    arrSizeBytes: 4 * GB,
    tags: [],
    ...over,
  });

  beforeEach(() => {
    upsertMediaBatch([
      media('s1', { libraryKind: 'show', guidTvdb: '11', sizeBytes: 4 * GB }),
      media('s2', { libraryKind: 'show', sizeBytes: 2 * GB }), // no tvdb id
      media('m1', { libraryKind: 'movie', guidTmdb: '22', sizeBytes: 8 * GB }),
    ]);
    replaceArrItems([
      arrItem({ ratingKey: 's1' }),
      arrItem({ ratingKey: 'm1', source: 'radarr', quality: 'Bluray-2160p', qualityKind: 'file', arrSizeBytes: 8 * GB }),
    ]);
    // s2 has no arr row → "Not in *arr"
  });

  it('replaceArrUnmatched / getArrUnmatched / clearArrUnmatched round-trip (largest first)', () => {
    replaceArrUnmatched([
      { source: 'sonarr', instanceId: 's1', instanceName: 'S', title: 'Ghost', extKind: 'tvdb', extId: '999', sizeBytes: 1_000 },
      { source: 'radarr', instanceId: 'r1', instanceName: 'R', title: 'Big Orphan', extKind: 'tmdb', extId: '42', sizeBytes: 9_000 },
    ]);
    const rows = getArrUnmatched();
    expect(rows.map((u) => u.title)).toEqual(['Big Orphan', 'Ghost']); // size DESC
    expect(rows[0].sizeBytes).toBe(9_000);
    expect(rows[0].instanceId).toBe('r1');
    clearArrUnmatched();
    expect(getArrUnmatched()).toEqual([]);
  });

  it('replaceArrUnmatched preserves rows of instances that failed this run', () => {
    replaceArrUnmatched([
      { source: 'sonarr', instanceId: 's1', instanceName: 'S', title: 'Ghost', extKind: 'tvdb', extId: '999', sizeBytes: 1_000 },
      { source: 'radarr', instanceId: 'r1', instanceName: 'R', title: 'Big Orphan', extKind: 'tmdb', extId: '42', sizeBytes: 9_000 },
    ]);
    // Sonarr (s1) failed the next run; Radarr (r1) succeeded with a new list.
    replaceArrUnmatched(
      [{ source: 'radarr', instanceId: 'r1', instanceName: 'R', title: 'Newcomer', extKind: 'tmdb', extId: '43', sizeBytes: 5_000 }],
      ['s1']
    );
    expect(getArrUnmatched().map((u) => u.title).sort()).toEqual(['Ghost', 'Newcomer']);
  });

  it('mediaMissingExternalIds counts only null-guid media', () => {
    const m = mediaMissingExternalIds();
    expect(m.shows).toBe(1); // s2
    expect(m.movies).toBe(0);
    expect(m.sample.some((s) => s.title === 'Title s2')).toBe(true);
  });

  it('arrMatchedCount = arr_items rows', () => {
    expect(arrMatchedCount()).toBe(2);
  });

  it('arrQualitySummary + unmatchedMediaSummary partition bytes', () => {
    const byQ = arrQualitySummary();
    expect(byQ.find((r) => r.quality === 'HD-1080p')).toMatchObject({
      titles: 1,
      bytes: 4 * GB,
      reclaimableBytes: 4 * GB,
      unwatchedBytes: 4 * GB,
    });
    expect(byQ.find((r) => r.quality === 'Bluray-2160p')).toMatchObject({ titles: 1, bytes: 8 * GB });
    expect(unmatchedMediaSummary()).toMatchObject({ titles: 1, bytes: 2 * GB }); // s2
  });
});

describe('ratingKeysByGuid (arr matching)', () => {
  beforeEach(() => {
    upsertMediaBatch([
      media('s1', { libraryKind: 'show', guidTvdb: '111' }),
      media('m1', { libraryKind: 'movie', guidTmdb: '222' }),
    ]);
  });

  it('maps tvdb→show and tmdb→movie rating keys (kind-scoped)', () => {
    expect(ratingKeysByGuid('tvdb').get('111')).toBe('s1');
    expect(ratingKeysByGuid('tmdb').get('222')).toBe('m1');
    expect(ratingKeysByGuid('tvdb').has('222')).toBe(false);
  });

  it('splits a CSV guid so ANY of an item\'s ids matches (multi-id Plex items)', () => {
    upsertMediaBatch([media('s2', { libraryKind: 'show', guidTvdb: '376459,407505' })]);
    const map = ratingKeysByGuid('tvdb');
    expect(map.get('376459')).toBe('s2'); // Sonarr's id matches even though it's first of two
    expect(map.get('407505')).toBe('s2');
  });

  it('imdb map spans movies AND shows (the extra match axis)', () => {
    upsertMediaBatch([
      media('mv', { libraryKind: 'movie', guidTmdb: null, guidImdb: 'tt9032390' }),
      media('sh', { libraryKind: 'show', guidTvdb: null, guidImdb: 'tt11704040' }),
    ]);
    const imdb = ratingKeysByGuid('imdb');
    expect(imdb.get('tt9032390')).toBe('mv'); // imdb-only movie now resolvable
    expect(imdb.get('tt11704040')).toBe('sh');
    // the tmdb map doesn't contain imdb ids (kept separate)
    expect(ratingKeysByGuid('tmdb').has('tt9032390')).toBe(false);
  });
});

describe('queryLibrary keptByMeOnly', () => {
  beforeEach(() => {
    upsertMediaBatch([media('1'), media('2'), media('3')]);
    addKeep('me', '1'); // my keep
    addKeep('other', '2'); // someone else's keep (protected, but not mine)
    // '3' — kept by nobody
  });

  it('keptByMeOnly returns only the caller\'s own keeps', () => {
    const rows = queryLibrary({
      plexUserId: 'me',
      limit: 100,
      offset: 0,
      keptByMeOnly: true,
    });
    expect(rows.map((r) => r.rating_key)).toEqual(['1']);
  });

  it('without keptByMeOnly, keptFilter=kept returns anyone\'s keeps', () => {
    const rows = queryLibrary({
      plexUserId: 'me',
      limit: 100,
      offset: 0,
      keptFilter: 'kept',
    });
    expect(rows.map((r) => r.rating_key).sort()).toEqual(['1', '2']);
  });
});

describe('queryLibrary combinable Status buckets (stateBuckets, OR)', () => {
  beforeEach(() => {
    upsertMediaBatch([
      media('1'), media('2'), media('3'), media('4'), media('5'), media('6'),
    ]);
    addKeep('me', '1'); // kept by me
    addKeep('other', '2'); // kept by someone else only (protected, not mine)
    addSkip('me', '3'); // I don't care
    addDelete('me', '4'); // OK to delete (by me)
    addDelete('other', '5'); // OK to delete (by someone else)
    // '6' — undecided
  });

  const q = (stateBuckets: LibraryQuery['stateBuckets']) =>
    queryLibrary({ plexUserId: 'me', limit: 100, offset: 0, stateBuckets })
      .map((r) => r.rating_key)
      .sort();

  it('empty/omitted = no filter (All)', () => {
    expect(q([])).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(q(undefined)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('each bucket selects only its own state', () => {
    expect(q(['keptByMe'])).toEqual(['1']);
    expect(q(['keptOther'])).toEqual(['2']);
    expect(q(['dontcare'])).toEqual(['3']);
    expect(q(['okDeleteMine'])).toEqual(['4']);
    expect(q(['okDeleteAny'])).toEqual(['4', '5']); // my own mark counts as "any" too
    // Undecided = "I" made no decision. '5' (marked by someone else, untouched by
    // me) counts — consistent with the prior Undecided view (excludes only YOUR
    // own keep/skip/delete).
    expect(q(['undecided'])).toEqual(['5', '6']);
  });

  it("multiple buckets are OR'd together (union)", () => {
    expect(q(['keptByMe', 'undecided'])).toEqual(['1', '5', '6']);
    expect(q(['keptByMe', 'keptOther'])).toEqual(['1', '2']);
    expect(q(['dontcare', 'okDeleteMine', 'undecided'])).toEqual(['3', '4', '5', '6']);
  });
});

describe('apply* exclusive mutations (atomic keep/skip/delete)', () => {
  beforeEach(() => {
    upsertMediaBatch([media('1'), media('2')]);
  });

  it('applyKeep sets the keep and clears skip + delete', () => {
    addSkip('userA', '1');
    addDelete('userA', '1');
    expect(applyKeep('userA', '1')).toBe(true);
    expect(isKeptByUser('userA', '1')).toBe(true);
    expect(isSkipped('userA', '1')).toBe(false);
    expect(isMarkedForDelete('userA', '1')).toBe(false);
  });

  it('applySkip sets the skip and clears keep + delete', () => {
    addKeep('userA', '1');
    addDelete('userA', '1');
    expect(applySkip('userA', '1')).toBe(true);
    expect(isSkipped('userA', '1')).toBe(true);
    expect(isKeptByUser('userA', '1')).toBe(false);
    expect(isMarkedForDelete('userA', '1')).toBe(false);
  });

  it('applyDelete sets the mark and clears keep + skip', () => {
    addKeep('userA', '1');
    addSkip('userA', '1');
    expect(applyDelete('userA', '1')).toBe(true);
    expect(isMarkedForDelete('userA', '1')).toBe(true);
    expect(isKeptByUser('userA', '1')).toBe(false);
    expect(isSkipped('userA', '1')).toBe(false);
  });

  it('returns false when already set but still clears the others', () => {
    applyKeep('userA', '1');
    addSkip('userA', '1'); // simulate a torn state
    expect(applyKeep('userA', '1')).toBe(false); // not newly kept
    expect(isSkipped('userA', '1')).toBe(false); // but exclusivity restored
  });

  it('only touches this user', () => {
    addKeep('userB', '1');
    applySkip('userA', '1');
    expect(isKeptByUser('userB', '1')).toBe(true);
  });
});

describe('applySkipBatch (batch skip with exclusivity + existence filter)', () => {
  beforeEach(() => {
    upsertMediaBatch([media('1'), media('2'), media('3')], 1000);
  });

  it('skips only existing keys and clears keeps/deletes for them', () => {
    addKeep('userA', '1');
    addDelete('userA', '2');
    const n = applySkipBatch('userA', ['1', '2', 'ghost']);
    expect(n).toBe(2); // ghost dropped
    expect(isSkipped('userA', '1')).toBe(true);
    expect(isSkipped('userA', '2')).toBe(true);
    expect(isSkipped('userA', 'ghost')).toBe(false);
    expect(isKeptByUser('userA', '1')).toBe(false);
    expect(isMarkedForDelete('userA', '2')).toBe(false);
  });

  it('ignores tombstoned items', () => {
    upsertMediaBatch([media('1'), media('2')], 2000);
    tombstoneStale(2000); // item 3 tombstoned
    expect(applySkipBatch('userA', ['3'])).toBe(0);
    expect(isSkipped('userA', '3')).toBe(false);
  });

  it('counts only newly skipped; other users untouched', () => {
    addKeep('userB', '1');
    expect(applySkipBatch('userA', ['1', '2'])).toBe(2);
    expect(applySkipBatch('userA', ['1', '2'])).toBe(0); // re-skip
    expect(isKeptByUser('userB', '1')).toBe(true);
  });
});

describe('getActiveMediaItem (tombstone-filtered existence gate)', () => {
  it('returns live items and null for tombstoned ones', () => {
    upsertMediaBatch([media('1'), media('2')], 1000);
    upsertMediaBatch([media('1')], 2000);
    tombstoneStale(2000); // item 2 tombstoned
    expect(getActiveMediaItem('1')?.rating_key).toBe('1');
    expect(getActiveMediaItem('2')).toBeNull();
    expect(getMediaItem('2')?.removed).toBe(1); // unfiltered getter still sees it
  });
});

describe('OK to delete (user_deletes)', () => {
  beforeEach(() => {
    upsertMediaBatch([media('1'), media('2'), media('3')]);
  });

  it('addDelete/removeDelete/isMarkedForDelete round-trip, scoped per user', () => {
    expect(addDelete('userA', '1')).toBe(true);
    expect(addDelete('userA', '1')).toBe(false); // idempotent
    expect(isMarkedForDelete('userA', '1')).toBe(true);
    expect(isMarkedForDelete('userB', '1')).toBe(false); // per-user
    expect(removeDelete('userA', '1')).toBe(true);
    expect(isMarkedForDelete('userA', '1')).toBe(false);
    expect(removeDelete('userA', '1')).toBe(false); // nothing to remove
  });

  it('isRequestedByUser reflects the Seerr request cache', () => {
    expect(isRequestedByUser('userA', '1')).toBe(false);
    replaceSeerrRequests('userA', ['1']);
    expect(isRequestedByUser('userA', '1')).toBe(true);
    expect(isRequestedByUser('userB', '1')).toBe(false);
  });

  it('getFeed excludes the user\'s own delete-marked items only', () => {
    addDelete('userA', '2');
    const a = getFeed('userA', 10).map((r) => r.rating_key).sort();
    const b = getFeed('userB', 10).map((r) => r.rating_key).sort();
    expect(a).toEqual(['1', '3']); // A's mark hides 2 from A
    expect(b).toEqual(['1', '2', '3']); // B unaffected
  });

  it('queryLibrary exposes requested + delete flags and the by-me/by-anyone filters', () => {
    replaceSeerrRequests('me', ['1']);
    addDelete('me', '1'); // mine
    addDelete('other', '2'); // someone else's

    const all = queryLibrary({ plexUserId: 'me', limit: 100, offset: 0 });
    const byKey = new Map(all.map((r) => [r.rating_key, r]));
    expect(byKey.get('1')!.requested_by_me).toBe(1);
    expect(byKey.get('1')!.marked_for_delete_by_me).toBe(1);
    expect(byKey.get('1')!.marked_for_delete_any).toBe(1);
    expect(byKey.get('2')!.requested_by_me).toBe(0);
    expect(byKey.get('2')!.marked_for_delete_by_me).toBe(0);
    expect(byKey.get('2')!.marked_for_delete_any).toBe(1); // released by other
    expect(byKey.get('3')!.marked_for_delete_any).toBe(0);

    const mine = queryLibrary({
      plexUserId: 'me',
      limit: 100,
      offset: 0,
      deleteFilter: 'deletedByMe',
    });
    expect(mine.map((r) => r.rating_key)).toEqual(['1']);

    const any = queryLibrary({
      plexUserId: 'me',
      limit: 100,
      offset: 0,
      deleteFilter: 'deletedAny',
    });
    expect(any.map((r) => r.rating_key).sort()).toEqual(['1', '2']);
  });

  it('Undecided (unkept + unskipped) also excludes my delete-marked items', () => {
    addDelete('me', '1');
    const undecided = queryLibrary({
      plexUserId: 'me',
      limit: 100,
      offset: 0,
      keptFilter: 'unkept',
      skipFilter: 'unskipped',
    });
    expect(undecided.map((r) => r.rating_key).sort()).toEqual(['2', '3']);
  });

  it('markedForDeleteItems attributes markers, flags still-kept, orders by size', () => {
    upsertMediaBatch([
      media('big', { sizeBytes: 50 * GB }),
      media('small', { sizeBytes: 1 * GB }),
    ]);
    upsertUser({ plexUserId: 'u1', username: 'Alice', email: null, thumb: null, isAdmin: false });
    upsertUser({ plexUserId: 'u2', username: 'Bob', email: null, thumb: null, isAdmin: false });
    addDelete('u1', 'big');
    addDelete('u2', 'big'); // two markers on one title
    addDelete('u1', 'small');
    addKeep('other', 'big'); // released by requesters but still kept → protected

    const rows = markedForDeleteItems();
    expect(rows.map((r) => r.ratingKey)).toEqual(['big', 'small']); // size DESC
    const big = rows[0];
    expect(big.markedBy.map((m) => m.username).sort()).toEqual(['Alice', 'Bob']);
    expect(big.keptByAnyone).toBe(true);
    expect(rows[1].keptByAnyone).toBe(false);

    expect(markedForDeleteSummary()).toEqual({ titles: 2, bytes: 51 * GB });
  });
});

describe('FORK: scheduled deletions', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const past = nowSec - 100;
  const future = nowSec + 30 * 86400;

  beforeEach(() => {
    upsertMediaBatch([media('1'), media('2'), media('3', { sizeBytes: 5 * GB })]);
  });

  it('tagForDeletion inserts pending; re-tag restarts a cancelled row', () => {
    expect(tagForDeletion('1', 'admin', future)).toBe(true);
    let [row] = listScheduledDeletions();
    expect(row.status).toBe('pending');
    expect(row.delete_after).toBe(future);

    cancelDeletion('1', 'admin');
    [row] = listScheduledDeletions();
    expect(row.status).toBe('cancelled');

    expect(tagForDeletion('1', 'admin', future + 1)).toBe(true);
    [row] = listScheduledDeletions();
    expect(row.status).toBe('pending');
    expect(row.delete_after).toBe(future + 1);
  });

  it('tagging rejects unknown + tombstoned items', () => {
    expect(tagForDeletion('nope', 'admin', future)).toBe(false);
    upsertMediaBatch([media('1')], 2000);
    upsertMediaBatch([media('2'), media('3')], 3000);
    tombstoneStale(3000); // '1' tombstoned
    expect(tagForDeletion('1', 'admin', future)).toBe(false);
  });

  it('tagging a currently-kept item starts it as held', () => {
    addKeep('userA', '1');
    tagForDeletion('1', 'admin', past);
    const [row] = listScheduledDeletions();
    expect(row.status).toBe('held');
    expect(row.kept).toBe(1);
    expect(dueDeletions(nowSec)).toHaveLength(0);
  });

  it('a new keep pauses a pending deletion (applyKeep flips it to held)', () => {
    tagForDeletion('1', 'admin', past);
    expect(dueDeletions(nowSec).map((r) => r.rating_key)).toEqual(['1']);
    applyKeep('userA', '1');
    const [row] = listScheduledDeletions();
    expect(row.status).toBe('held');
    expect(dueDeletions(nowSec)).toHaveLength(0);
  });

  it('refreshDeletionHolds resumes the countdown when the keep goes away', () => {
    tagForDeletion('1', 'admin', past);
    applyKeep('userA', '1'); // → held
    removeKeep('userA', '1');
    const { held, released } = refreshDeletionHolds();
    expect(held).toBe(0);
    expect(released).toBe(1);
    expect(dueDeletions(nowSec).map((r) => r.rating_key)).toEqual(['1']);
  });

  it('refreshDeletionHolds parks pending items someone keeps (e.g. raw addKeep)', () => {
    tagForDeletion('1', 'admin', past);
    addKeep('userB', '1'); // raw insert — no applyKeep hold
    const { held } = refreshDeletionHolds();
    expect(held).toBe(1);
    expect(dueDeletions(nowSec)).toHaveLength(0);
  });

  it('dueDeletions: only pending, past-due, present, unkept items', () => {
    tagForDeletion('1', 'admin', past); // due
    tagForDeletion('2', 'admin', future); // not yet due
    tagForDeletion('3', 'admin', past);
    addKeep('userA', '3'); // kept → ineligible even though past due
    expect(dueDeletions(nowSec).map((r) => r.rating_key)).toEqual(['1']);
  });

  it('setDeletionResult records the purge outcome', () => {
    tagForDeletion('1', 'admin', past);
    setDeletionResult('1', 'deleted', 'deleted via radarr (Main)');
    const [row] = listScheduledDeletions();
    expect(row.status).toBe('deleted');
    expect(row.status_detail).toBe('deleted via radarr (Main)');
    expect(dueDeletions(nowSec)).toHaveLength(0);
  });

  it('arrMatchForItem returns the owning instance or null', () => {
    expect(arrMatchForItem('1')).toBeNull();
    replaceArrItems([
      {
        ratingKey: '1',
        source: 'radarr',
        instanceId: 'r1',
        instanceName: 'Radarr',
        arrId: 42,
        monitored: true,
        status: 'released',
        quality: 'Bluray-1080p',
        qualityKind: 'file',
        rootFolder: null,
        arrSizeBytes: GB,
        tags: [],
      },
    ]);
    expect(arrMatchForItem('1')).toEqual({
      source: 'radarr',
      instance_id: 'r1',
      instance_name: 'Radarr',
      arr_id: 42,
    });
  });

  it('queryLibrary: scheduledDeletion bucket + live-tag fields on rows', () => {
    tagForDeletion('1', 'admin', future);
    tagForDeletion('2', 'admin', past);
    cancelDeletion('2', 'admin'); // cancelled tag must NOT surface
    const rows = queryLibrary({
      plexUserId: 'userA',
      limit: 100,
      offset: 0,
      stateBuckets: ['scheduledDeletion'],
    });
    expect(rows.map((r) => r.rating_key)).toEqual(['1']);
    expect(rows[0].scheduled_delete_after).toBe(future);
    expect(rows[0].scheduled_delete_status).toBe('pending');
    const all = queryLibrary({ plexUserId: 'userA', limit: 100, offset: 0 });
    expect(all.find((r) => r.rating_key === '2')?.scheduled_delete_after).toBeNull();
  });
});
