/**
 * FORK: batch tagging on POST /api/admin/scheduled-deletions — the Problems
 * page triages a list at a time, and N separate calls would mean N Discord
 * pings. The single-key contract must survive unchanged alongside it.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const { cookieJar } = vi.hoisted(() => ({ cookieJar: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined,
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
}));

import { __setTestDbToMemory, __closeDb } from '@/lib/db';
import {
  addKeep,
  listScheduledDeletions,
  upsertMediaBatch,
  upsertUser,
  type UpsertMediaInput,
} from '@/lib/queries';
import { setSessionCookie } from '@/lib/auth';
import { setDeletionGraceDays } from '@/lib/settings';
import { POST as tagPost } from '@/app/api/admin/scheduled-deletions/route';

const GB = 1024 ** 3;

function media(ratingKey: string): UpsertMediaInput {
  return {
    ratingKey,
    sectionId: '1',
    libraryKind: 'movie',
    title: `Title ${ratingKey}`,
    year: 2020,
    thumb: null,
    sizeBytes: 5 * GB,
    addedAt: 1000,
    guidTmdb: null,
    guidTvdb: null,
  };
}

function req(body: unknown) {
  return new Request('http://localhost/api/admin/scheduled-deletions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function loginAdmin() {
  upsertUser({ plexUserId: 'admin', username: 'Admin', email: null, thumb: null, isAdmin: true });
  await setSessionCookie('admin');
}

beforeEach(async () => {
  cookieJar.clear();
  __setTestDbToMemory();
  upsertMediaBatch([media('a'), media('b'), media('c')]);
  await loginAdmin();
});
afterAll(() => {
  __closeDb();
});

describe('POST /api/admin/scheduled-deletions (batch)', () => {
  it('tags every key in one call, with one shared deadline', async () => {
    setDeletionGraceDays(14);
    const res = await tagPost(req({ ratingKeys: ['a', 'b'] }));
    const body = await res.json();
    expect(body.tagged).toBe(2);
    expect(body.skipped).toBe(0);
    const rows = listScheduledDeletions();
    expect(rows.map((r) => r.rating_key).sort()).toEqual(['a', 'b']);
    expect(new Set(rows.map((r) => r.delete_after)).size).toBe(1);
    expect(rows[0].delete_after - rows[0].tagged_at).toBeGreaterThan(13 * 86400);
  });

  it('a dead id costs only itself, and is reported', async () => {
    // One bad key in a batch of twenty must not throw away the other nineteen.
    const body = await (await tagPost(req({ ratingKeys: ['a', 'ghost'] }))).json();
    expect(body.tagged).toBe(1);
    expect(body.skipped).toBe(1);
    expect(listScheduledDeletions().map((r) => r.rating_key)).toEqual(['a']);
  });

  it('keeps still win: a kept item is tagged as held, not refused', async () => {
    addKeep('u1', 'a');
    const body = await (await tagPost(req({ ratingKeys: ['a'] }))).json();
    expect(body.tagged).toBe(1);
    expect(listScheduledDeletions()[0].status).toBe('held');
  });

  it('the single-key contract is unchanged, including its 404', async () => {
    const ok = await tagPost(req({ ratingKey: 'a' }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).deleteAfter).toBeGreaterThan(0);
    expect((await tagPost(req({ ratingKey: 'ghost' }))).status).toBe(404);
  });

  it('refuses a body that is neither, or an implausibly large batch', async () => {
    expect((await tagPost(req({}))).status).toBe(400);
    expect((await tagPost(req({ ratingKeys: [] }))).status).toBe(400);
    expect((await tagPost(req({ ratingKeys: [1, 2] }))).status).toBe(400);
    const huge = Array.from({ length: 201 }, (_, i) => String(i));
    expect((await tagPost(req({ ratingKeys: huge }))).status).toBe(400);
  });

  it('403s a non-admin', async () => {
    upsertUser({ plexUserId: 'u2', username: 'U2', email: null, thumb: null, isAdmin: false });
    await setSessionCookie('u2');
    expect((await tagPost(req({ ratingKeys: ['a'] }))).status).toBe(403);
  });
});
