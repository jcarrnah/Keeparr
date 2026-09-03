/**
 * FORK: the Problems page fix-it actions route. Real in-memory SQLite for
 * storage; only the cookie jar and the media-server refresh are mocked.
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

// The action must not reach a real media server.
vi.mock('@/lib/post-delete-cleanup', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/post-delete-cleanup')>();
  return { ...mod, triggerServerRefresh: vi.fn() };
});

// …nor actually run a sweep. The ORDER these are called in is the thing under
// test, so record it rather than just counting.
const { jobCalls } = vi.hoisted(() => ({ jobCalls: [] as string[] }));
vi.mock('@/lib/jobs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/jobs')>();
  return {
    ...mod,
    runJob: vi.fn(async (id: string) => {
      jobCalls.push(id);
      return true;
    }),
  };
});

import { __setTestDbToMemory, __closeDb, getDb } from '@/lib/db';
import {
  addKeep,
  isKeptByUser,
  upsertMediaBatch,
  upsertUser,
  type UpsertMediaInput,
} from '@/lib/queries';
import { setSessionCookie } from '@/lib/auth';
import { triggerServerRefresh } from '@/lib/post-delete-cleanup';
import { POST as actionsPost } from '@/app/api/admin/problem-actions/route';

const mockRefresh = vi.mocked(triggerServerRefresh);
const GB = 1024 ** 3;

beforeEach(() => {
  cookieJar.clear();
  __setTestDbToMemory();
  vi.clearAllMocks();
  jobCalls.length = 0;
  mockRefresh.mockResolvedValue(true);
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
    sizeBytes: 1 * GB,
    addedAt: 1000,
    guidTmdb: null,
    guidTvdb: null,
    ...over,
  };
}

const post = (action: unknown) =>
  new Request('http://localhost/api/admin/problem-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });

describe('FORK: POST /api/admin/problem-actions', () => {
  it('requires an admin', async () => {
    await loginAs('regular', false);
    expect((await actionsPost(post('relink'))).status).toBe(403);
  });

  it('rejects an unknown action', async () => {
    await loginAs('admin', true);
    const res = await actionsPost(post('nope'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_request');
  });

  it('relink moves a stranded keep onto the live copy', async () => {
    await loginAs('admin', true);
    upsertMediaBatch([
      media('old', { guidTmdb: '603' }),
      media('new4k', { guidTmdb: '603' }),
    ]);
    getDb().prepare("UPDATE media_items SET removed = 1 WHERE rating_key = 'old'").run();
    addKeep('admin', 'old');

    const res = await actionsPost(post('relink'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.changed).toBe(1);
    expect(body.message).toMatch(/Re-linked 1 replaced item/);
    expect(isKeptByUser('admin', 'new4k')).toBe(true);
  });

  it('relink reports plainly when there is nothing to fix', async () => {
    await loginAs('admin', true);
    const body = await (await actionsPost(post('relink'))).json();
    expect(body.changed).toBe(0);
    expect(body.message).toMatch(/Nothing to re-link/);
  });

  it('rescan triggers a library refresh', async () => {
    await loginAs('admin', true);
    const body = await (await actionsPost(post('rescan'))).json();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(body.changed).toBe(1);
    expect(body.message).toMatch(/rescan started/);
  });

  it('rescan says so when the backend has no refresh (Plex)', async () => {
    await loginAs('admin', true);
    mockRefresh.mockResolvedValue(false);
    const body = await (await actionsPost(post('rescan'))).json();
    expect(body.changed).toBe(0);
    expect(body.message).toMatch(/No rescan available/);
  });

  // The loop-closer: a source fix lands in ANOTHER app, and this page reads
  // Keeparr's cache, so a fixed title keeps showing until Keeparr re-reads the
  // server and re-matches *arr — two nightly jobs apart.
  describe('recheck', () => {
    it('runs the library sync THEN the arr re-match', async () => {
      await loginAs('admin', true);
      const body = await (await actionsPost(post('recheck'))).json();
      expect(body.ok).toBe(true);
      // Fire-and-forget: let the chained runJob settle before asserting.
      await new Promise((r) => setImmediate(r));
      // Order is the point — `arr` matches on the ids `library` just
      // refreshed, so the reverse re-matches against stale guids.
      expect(jobCalls).toEqual(['library', 'arr']);
    });

    it('reports 0 changed so the page does not refetch mid-sweep', async () => {
      await loginAs('admin', true);
      const body = await (await actionsPost(post('recheck'))).json();
      // Refetching while the sweep runs shows identical rows, which reads as
      // "the button did nothing" — the exact complaint this action answers.
      expect(body.changed).toBe(0);
      expect(body.message).toMatch(/Re-checking/);
    });

    it('requires an admin', async () => {
      await loginAs('regular', false);
      expect((await actionsPost(post('recheck'))).status).toBe(403);
      await new Promise((r) => setImmediate(r));
      expect(jobCalls).toEqual([]);
    });
  });
});
