/**
 * FORK: live "movie night" swipe rooms — orchestration over the room queries.
 * Transport is short polling (no new deps); a room lands on the first title
 * EVERYONE currently present swipes "want to watch". Presence is last_seen,
 * refreshed by each ~2s poll; a member idle past ACTIVE_WINDOW_SEC stops
 * counting toward (or blocking) a match. Rooms are DB-backed so they survive
 * the container restart that ships on every push.
 */
import { toCard } from './cards';
import {
  computeRoomMatch,
  createRoom,
  getMediaItem,
  getRoomRow,
  pruneStaleRooms,
  roomActiveCount,
  roomMembers,
  setRoomMatched,
  type RoomRow,
} from './queries';
import type { FeedWatchMode, RoomState } from './types';

/** How long since last_seen a member still counts as "present". Poll is ~2s. */
export const ACTIVE_WINDOW_SEC = 25;
/** Open rooms older than this are auto-closed (housekeeping on create). */
export const ROOM_TTL_SEC = 12 * 3600;

// Unambiguous alphabet (no I/O/0/1) so codes are easy to read aloud/type.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(len = 4): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Create a room with a collision-free code and auto-join the host. Prunes stale
 * rooms first so old codes free up. Returns the new code.
 */
export function createUniqueRoom(input: {
  hostId: string;
  hostName: string | null;
  sectionId: string | null;
  watchMode: FeedWatchMode | null;
}): string {
  pruneStaleRooms(nowSec() - ROOM_TTL_SEC);
  let code = randomCode();
  for (let tries = 0; getRoomRow(code) && tries < 12; tries++) {
    code = randomCode(tries < 6 ? 4 : 5); // widen if 4-char space is unlucky
  }
  createRoom({ ...input, code });
  return code;
}

/**
 * Recompute consensus and, if a title now has every present member's "want",
 * atomically land the room on it. Returns the matched rating key (whether this
 * call or a prior one committed it) or null. Safe to call on every poll + vote.
 */
export function evaluateMatch(code: string): string | null {
  const room = getRoomRow(code);
  if (!room) return null;
  if (room.status === 'matched') return room.matched_rating_key;
  if (room.status !== 'open') return null;
  const rk = computeRoomMatch(code, nowSec() - ACTIVE_WINDOW_SEC);
  if (!rk) return null;
  setRoomMatched(code, rk); // atomic; a racing poller committing the same rk is fine
  return getRoomRow(code)?.matched_rating_key ?? null;
}

/** Assemble the full poll payload for a viewer, or null if the room is gone. */
export function buildRoomState(
  room: RoomRow,
  viewer: { plexUserId: string }
): RoomState {
  const activeSince = nowSec() - ACTIVE_WINDOW_SEC;
  const members = roomMembers(room.code, activeSince).map((m) => ({
    plexUserId: m.plex_user_id,
    username: m.username,
    active: !!m.active,
    votes: m.votes,
    isMe: m.plex_user_id === viewer.plexUserId,
  }));
  const matchedItem = room.matched_rating_key
    ? getMediaItem(room.matched_rating_key)
    : null;
  return {
    code: room.code,
    status: room.status,
    isHost: room.created_by === viewer.plexUserId,
    sectionId: room.section_id,
    watchMode: room.watch_mode,
    members,
    activeCount: roomActiveCount(room.code, activeSince),
    matched: matchedItem ? toCard(matchedItem, false) : null,
  };
}

/** Convenience: state by code (null when the room doesn't exist). */
export function roomStateByCode(
  code: string,
  viewer: { plexUserId: string }
): RoomState | null {
  const room = getRoomRow(code);
  return room ? buildRoomState(room, viewer) : null;
}
