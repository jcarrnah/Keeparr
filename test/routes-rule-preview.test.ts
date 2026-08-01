/**
 * FORK (3.2): the rule preview has to explain itself. A vote-matching rule that
 * quietly reports 1 instead of 3 reads as broken; the route reports the quorum
 * in force and what it held back, so the number makes sense before saving.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Mock ONLY the cookie jar (next/headers). The database stays real (in-memory).
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
  applyVerdict,
  tagForDeletion,
  upsertMediaBatch,
  upsertUser,
  type UpsertMediaInput,
} from '@/lib/queries';
import { setSessionCookie } from '@/lib/auth';
import { POST as previewPost } from '@/app/api/admin/deletion-rules/preview/route';

const GB = 1024 ** 3;

function media(ratingKey: string): UpsertMediaInput {
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
  };
}

function req(conditions: unknown) {
  return new Request('http://localhost/api/admin/deletion-rules/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conditions }),
  });
}

async function loginAdmin() {
  upsertUser({ plexUserId: 'admin', username: 'Admin', email: null, thumb: null, isAdmin: true });
  await setSessionCookie('admin');
}

beforeEach(() => {
  cookieJar.clear();
  __setTestDbToMemory();
});
afterAll(() => {
  __closeDb();
});

describe('POST /api/admin/deletion-rules/preview', () => {
  it('403s a non-admin', async () => {
    upsertUser({ plexUserId: 'u1', username: 'U1', email: null, thumb: null, isAdmin: false });
    await setSessionCookie('u1');
    expect((await previewPost(req([{ field: 'size', op: 'gtGB', value: 1 }]))).status).toBe(403);
  });

  it('400s on conditions it would refuse to save', async () => {
    await loginAdmin();
    expect((await previewPost(req([]))).status).toBe(400);
    expect(
      (await previewPost(req([{ field: 'verdict_count', op: 'gte', value: 2 }]))).status
    ).toBe(400); // no verdict named
  });

  it('reports the quorum and what it held back', async () => {
    await loginAdmin();
    upsertMediaBatch([media('a'), media('b')]);
    for (const id of ['u1', 'u2']) {
      upsertUser({ plexUserId: id, username: id, email: null, thumb: null, isAdmin: false });
    }
    applyVerdict('u1', 'a', 'not_interested'); // +2, two voters once u2 joins
    applyVerdict('u2', 'a', 'not_interested');
    applyVerdict('u1', 'b', 'not_interested'); // +2 but a lone voice

    const res = await previewPost(req([{ field: 'verdict_score', op: 'gte', value: 2 }]));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.sample[0].title).toBe('Title a');
    expect(body.minVoters).toBe(2);
    expect(body.heldByQuorum).toBe(1); // 'b' — matched, but only one person said so
    expect(body.excludedKept).toBe(0);
    expect(body.excludedTagged).toBe(0);
  });

  it('names the baseline exclusions that make Browse look bigger', async () => {
    await loginAdmin();
    upsertMediaBatch([media('a'), media('b'), media('c')]);
    for (const id of ['u1', 'u2']) {
      upsertUser({ plexUserId: id, username: id, email: null, thumb: null, isAdmin: false });
      for (const key of ['a', 'b', 'c']) applyVerdict(id, key, 'not_interested');
    }
    addKeep('u1', 'b'); // a keep beats the household
    tagForDeletion('c', 'admin', 2_000_000_000); // already tagged

    const body = await (
      await previewPost(req([{ field: 'verdict_score', op: 'gte', value: 2 }]))
    ).json();
    expect(body.count).toBe(1); // only 'a'
    expect(body.excludedKept).toBe(1);
    expect(body.excludedTagged).toBe(1);
    expect(body.heldByQuorum).toBe(0);
  });

  it('reports no quorum for a rule that reads no opinions', async () => {
    await loginAdmin();
    upsertMediaBatch([media('a')]);
    const body = await (await previewPost(req([{ field: 'size', op: 'gtGB', value: 1 }]))).json();
    expect(body.count).toBe(1);
    expect(body.minVoters).toBeNull();
    expect(body.heldByQuorum).toBe(0);
  });
});
