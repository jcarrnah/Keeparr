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
import { upsertUser, bumpSessionEpoch, getUserEpoch, setUserEnabled } from '@/lib/queries';
import { getSessionUser, setSessionCookie } from '@/lib/auth';
import { POST as logoutAllPost } from '@/app/api/auth/logout-all/route';

async function loginAs(id: string) {
  upsertUser({ plexUserId: id, username: id, email: null, thumb: null, isAdmin: false });
  await setSessionCookie(id);
}

beforeEach(() => {
  cookieJar.clear();
  __setTestDbToMemory();
});
afterAll(() => __closeDb());

describe('session epoch revocation', () => {
  it('a token minted before an epoch bump is rejected (stolen-token scenario)', async () => {
    await loginAs('userA');
    expect((await getSessionUser())?.plexUserId).toBe('userA');

    // Another device runs "sign out all devices".
    bumpSessionEpoch('userA');

    // The old cookie is still present but now stale → treated as logged-out.
    expect(await getSessionUser()).toBeNull();

    // Signing in again mints a token at the new epoch and works.
    await setSessionCookie('userA');
    expect((await getSessionUser())?.plexUserId).toBe('userA');
  });

  it('POST /api/auth/logout-all bumps the epoch and clears the cookie', async () => {
    await loginAs('userA');
    expect(getUserEpoch('userA')).toBe(0);

    const res = await logoutAllPost();
    expect(res.status).toBe(200);
    expect(getUserEpoch('userA')).toBe(1);
    expect(await getSessionUser()).toBeNull();
  });

  it('disabling a user invalidates their existing tokens immediately', async () => {
    await loginAs('userB');
    expect((await getSessionUser())?.plexUserId).toBe('userB');
    setUserEnabled('userB', false);
    // Both the enabled check AND the epoch bump now reject the old token.
    expect(await getSessionUser()).toBeNull();
    expect(getUserEpoch('userB')).toBe(1);
  });

  it('logout-all requires a session', async () => {
    const res = await logoutAllPost();
    expect(res.status).toBe(401);
  });
});
