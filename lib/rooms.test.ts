import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { __setTestDbToMemory, __closeDb, getDb } from './db';
import {
  closeRoom,
  countRoomDeckRemaining,
  computeRoomMatch,
  createRoom,
  getRoomDeck,
  getRoomRow,
  isRoomMember,
  joinRoom,
  leaveRoom,
  pruneStaleRooms,
  recordRoomVote,
  roomActiveCount,
  roomMembers,
  setRoomMatched,
  upsertMediaBatch,
  type UpsertMediaInput,
} from './queries';
import {
  ACTIVE_WINDOW_SEC,
  buildRoomState,
  createUniqueRoom,
  evaluateMatch,
} from './rooms';

const GB = 1024 ** 3;
const nowSec = () => Math.floor(Date.now() / 1000);

function media(rk: string, over: Partial<UpsertMediaInput> = {}): UpsertMediaInput {
  return {
    ratingKey: rk,
    sectionId: '1',
    libraryKind: 'movie',
    title: `Title ${rk}`,
    year: 2020,
    thumb: null,
    sizeBytes: 1 * GB,
    addedAt: Number(rk.replace(/\D/g, '')) || 1000, // deterministic order by added_at
    guidTmdb: null,
    guidTvdb: null,
    ...over,
  };
}

/** Backdate a member's presence so they fall outside the active window. */
function makeIdle(code: string, userId: string) {
  getDb()
    .prepare('UPDATE swipe_room_members SET last_seen = ? WHERE code = ? AND plex_user_id = ?')
    .run(nowSec() - ACTIVE_WINDOW_SEC - 100, code, userId);
}

beforeEach(() => {
  __setTestDbToMemory();
  upsertMediaBatch([media('1'), media('2'), media('3')]);
});
afterAll(() => __closeDb());

describe('room lifecycle', () => {
  it('creates a room with the host as first member', () => {
    createRoom({ code: 'AAAA', hostId: 'host', hostName: 'Host', sectionId: null, watchMode: null });
    const room = getRoomRow('AAAA');
    expect(room?.status).toBe('open');
    expect(room?.created_by).toBe('host');
    expect(isRoomMember('AAAA', 'host')).toBe(true);
  });

  it('createUniqueRoom returns a usable code + host membership', () => {
    const code = createUniqueRoom({ hostId: 'host', hostName: 'Host', sectionId: null, watchMode: null });
    expect(code.length).toBeGreaterThanOrEqual(4);
    expect(getRoomRow(code)?.created_by).toBe('host');
    expect(isRoomMember(code, 'host')).toBe(true);
  });

  it('join adds members; leave removes them', () => {
    createRoom({ code: 'BBBB', hostId: 'host', hostName: 'Host', sectionId: null, watchMode: null });
    joinRoom('BBBB', 'guest', 'Guest');
    expect(roomActiveCount('BBBB', nowSec() - ACTIVE_WINDOW_SEC)).toBe(2);
    leaveRoom('BBBB', 'guest');
    expect(isRoomMember('BBBB', 'guest')).toBe(false);
  });

  it('pruneStaleRooms closes old open rooms only', () => {
    createRoom({ code: 'OLD1', hostId: 'h', hostName: null, sectionId: null, watchMode: null });
    getDb().prepare('UPDATE swipe_rooms SET created_at = ? WHERE code = ?').run(nowSec() - 99999, 'OLD1');
    createRoom({ code: 'NEW1', hostId: 'h', hostName: null, sectionId: null, watchMode: null });
    const closed = pruneStaleRooms(nowSec() - 3600);
    expect(closed).toBe(1);
    expect(getRoomRow('OLD1')?.status).toBe('closed');
    expect(getRoomRow('NEW1')?.status).toBe('open');
  });
});

describe('match rule: the room lands only when everyone present wants it', () => {
  beforeEach(() => {
    createRoom({ code: 'ROOM', hostId: 'a', hostName: 'A', sectionId: null, watchMode: null });
    joinRoom('ROOM', 'b', 'B');
  });
  const since = () => nowSec() - ACTIVE_WINDOW_SEC;

  it('one want is not enough', () => {
    recordRoomVote('ROOM', 'a', '1', true);
    expect(computeRoomMatch('ROOM', since())).toBeNull();
  });

  it('both wanting the same title matches it', () => {
    recordRoomVote('ROOM', 'a', '1', true);
    recordRoomVote('ROOM', 'b', '1', true);
    expect(computeRoomMatch('ROOM', since())).toBe('1');
  });

  it('a pass by one blocks the match', () => {
    recordRoomVote('ROOM', 'a', '1', true);
    recordRoomVote('ROOM', 'b', '1', false);
    expect(computeRoomMatch('ROOM', since())).toBeNull();
  });

  it('needs at least two present members', () => {
    // Solo room: even a want on its own can't match.
    createRoom({ code: 'SOLO', hostId: 'z', hostName: 'Z', sectionId: null, watchMode: null });
    recordRoomVote('SOLO', 'z', '1', true);
    expect(computeRoomMatch('SOLO', since())).toBeNull();
  });

  it('an idle member stops blocking a match', () => {
    joinRoom('ROOM', 'c', 'C'); // three present now
    recordRoomVote('ROOM', 'a', '1', true);
    recordRoomVote('ROOM', 'b', '1', true);
    // C never voted → with 3 present, no consensus.
    expect(computeRoomMatch('ROOM', since())).toBeNull();
    // C goes idle → active drops to A+B, who both want it.
    makeIdle('ROOM', 'c');
    expect(computeRoomMatch('ROOM', since())).toBe('1');
  });

  it('picks the title that reached consensus first', () => {
    recordRoomVote('ROOM', 'a', '2', true);
    recordRoomVote('ROOM', 'a', '1', true);
    recordRoomVote('ROOM', 'b', '1', true); // '1' completes first
    recordRoomVote('ROOM', 'b', '2', true); // '2' completes later
    expect(computeRoomMatch('ROOM', since())).toBe('1');
  });
});

describe('evaluateMatch + buildRoomState', () => {
  it('commits the match and surfaces the matched card', () => {
    createRoom({ code: 'MTCH', hostId: 'a', hostName: 'A', sectionId: null, watchMode: null });
    joinRoom('MTCH', 'b', 'B');
    recordRoomVote('MTCH', 'a', '1', true);
    recordRoomVote('MTCH', 'b', '1', true);
    expect(evaluateMatch('MTCH')).toBe('1');
    // Idempotent — a second call returns the same committed key.
    expect(evaluateMatch('MTCH')).toBe('1');
    const state = buildRoomState(getRoomRow('MTCH')!, { plexUserId: 'a' });
    expect(state.status).toBe('matched');
    expect(state.matched?.ratingKey).toBe('1');
    expect(state.isHost).toBe(true);
    expect(state.members.find((m) => m.plexUserId === 'a')?.isMe).toBe(true);
  });

  it('setRoomMatched only fires once', () => {
    createRoom({ code: 'ONCE', hostId: 'a', hostName: null, sectionId: null, watchMode: null });
    expect(setRoomMatched('ONCE', '1')).toBe(true);
    expect(setRoomMatched('ONCE', '2')).toBe(false); // already matched
    expect(getRoomRow('ONCE')?.matched_rating_key).toBe('1');
  });
});

describe('room deck (shared, deterministic, excludes own votes)', () => {
  it('serves newest-first and drops what this user already swiped', () => {
    createRoom({ code: 'DECK', hostId: 'a', hostName: null, sectionId: null, watchMode: null });
    const room = getRoomRow('DECK')!;
    const first = getRoomDeck(room, 'a', 30).map((m) => m.rating_key);
    expect(first).toEqual(['3', '2', '1']); // added_at desc
    expect(countRoomDeckRemaining(room, 'a')).toBe(3);
    recordRoomVote('DECK', 'a', '3', true);
    const after = getRoomDeck(room, 'a', 30).map((m) => m.rating_key);
    expect(after).toEqual(['2', '1']);
    expect(countRoomDeckRemaining(room, 'a')).toBe(2);
    // Another member's deck is unaffected by A's votes.
    expect(getRoomDeck(room, 'b', 30).map((m) => m.rating_key)).toEqual(['3', '2', '1']);
  });

  it('respects a section filter', () => {
    upsertMediaBatch([media('99', { sectionId: '2', addedAt: 5000 })]);
    createRoom({ code: 'SECT', hostId: 'a', hostName: null, sectionId: '2', watchMode: null });
    const room = getRoomRow('SECT')!;
    expect(getRoomDeck(room, 'a', 30).map((m) => m.rating_key)).toEqual(['99']);
  });

  it('closeRoom flips status', () => {
    createRoom({ code: 'CLOS', hostId: 'a', hostName: null, sectionId: null, watchMode: null });
    closeRoom('CLOS');
    expect(getRoomRow('CLOS')?.status).toBe('closed');
  });
});
