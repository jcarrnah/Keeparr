/**
 * FORK (3.1): the scheduled-deletions endpoint that backs the deletion audit
 * trail. Real in-memory SQLite; only the cookie jar and Discord are mocked.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
    set: (name: string, value: string) => cookieJar.set(name, value),
    delete: (name: string) => cookieJar.delete(name),
  }),
}));

// Tagging fires a webhook; it must never reach the network from a test.
vi.mock('@/lib/discord', () => ({ sendDiscordMessage: vi.fn() }));

import { __setTestDbToMemory, __closeDb, getDb } from '@/lib/db';
import {
  addKeep,
  setDeletionVerification,
  tagForDeletion,
  upsertMediaBatch,
  upsertUser,
  type UpsertMediaInput,
} from '@/lib/queries';
import { setSessionCookie } from '@/lib/auth';
import { GET, DELETE } from '@/app/api/admin/scheduled-deletions/route';

const GB = 1024 ** 3;
const nowSec = Math.floor(Date.now() / 1000);

beforeEach(() => {
  cookieJar.clear();
  __setTestDbToMemory();
  vi.clearAllMocks();
});
afterAll(() => __closeDb());

async function loginAs(plexUserId: string, isAdmin = false) {
  upsertUser({ plexUserId, username: plexUserId, email: null, thumb: null, isAdmin });
  await setSessionCookie(plexUserId);
}

function media(ratingKey: string, over: Partial<UpsertMediaInput> = {}): UpsertMediaInput {
  return {
    ratingKey,
    sectionId: '1',
    libraryKind: 'movie',
    title: `Title ${ratingKey}`,
    year: 2020,
    thumb: null,
    sizeBytes: 10 * GB,
    addedAt: 1000,
    guidTmdb: null,
    guidTvdb: null,
    ...over,
  };
}

const markDeleted = (ratingKey: string) =>
  getDb()
    .prepare("UPDATE scheduled_deletions SET status = 'deleted' WHERE rating_key = ?")
    .run(ratingKey);

describe('FORK: GET /api/admin/scheduled-deletions (the audit trail)', () => {
  it('requires an admin', async () => {
    await loginAs('regular', false);
    expect((await GET()).status).toBe(403);
  });

  it('reports per-status counts and the live-tag state', async () => {
    await loginAs('admin', true);
    upsertMediaBatch([media('1'), media('2'), media('3')]);
    tagForDeletion('1', 'admin', nowSec + 86400);
    tagForDeletion('2', 'admin', nowSec + 86400);
    markDeleted('2');
    addKeep('someone', '3');
    tagForDeletion('3', 'admin', nowSec + 86400); // kept → tagged as 'held'

    const body = await (await GET()).json();

    expect(body.summary.pending.count).toBe(1);
    expect(body.summary.deleted.count).toBe(1);
    expect(body.summary.held.count).toBe(1);
    expect(body.items.find((i: { ratingKey: string }) => i.ratingKey === '3').kept).toBe(true);
  });

  it('measures reclaim from the disk, and never counts unverified as gone', async () => {
    await loginAs('admin', true);
    upsertMediaBatch([media('1'), media('2'), media('3')]);
    for (const k of ['1', '2', '3']) {
      tagForDeletion(k, 'admin', nowSec - 10);
      markDeleted(k);
    }
    setDeletionVerification('1', 0); // really gone
    setDeletionVerification('2', 2 * GB); // left bytes behind
    // '3' is never verified — section unmapped / root unreadable.

    const body = await (await GET()).json();

    // Only the two VERIFIED deletions back the measured figure: 20 GB claimed
    // minus 2 GB still on disk.
    expect(body.reclaim.verifiedClaimedBytes).toBe(20 * GB);
    expect(body.reclaim.residueBytes).toBe(2 * GB);
    expect(body.reclaim.verifiedCount).toBe(2);
    expect(body.reclaim.unverifiedCount).toBe(1);
    // The claim across all three is higher than what was actually measured —
    // that gap is the whole point of the screen.
    expect(body.reclaim.claimedBytes).toBe(30 * GB);

    expect(body.residueItems).toEqual([
      expect.objectContaining({ ratingKey: '2', residueBytes: 2 * GB }),
    ]);
  });

  it('keeps a cancelled tag as a record rather than dropping it', async () => {
    await loginAs('admin', true);
    upsertMediaBatch([media('1')]);
    tagForDeletion('1', 'admin', nowSec + 86400);

    const res = await DELETE(
      new Request('http://localhost/api/admin/scheduled-deletions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ratingKey: '1' }),
      })
    );
    expect(res.status).toBe(200);

    const body = await (await GET()).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].status).toBe('cancelled');
    expect(body.summary.cancelled.count).toBe(1);
  });
});
