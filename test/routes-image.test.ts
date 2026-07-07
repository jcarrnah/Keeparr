import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

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

// Keep the disk poster cache out of the test: never hit, never written.
vi.mock('@/lib/cache', () => ({
  readImageCache: () => null,
  writeImageCache: vi.fn(),
}));

import { __setTestDbToMemory, __closeDb } from '@/lib/db';
import { upsertUser } from '@/lib/queries';
import { setApiKey, setMediaServerType, setServerField } from '@/lib/settings';
import { setSessionCookie } from '@/lib/auth';
import { GET as imageGet } from '@/app/api/image/route';

const PATH = '/library/metadata/1/thumb/1';

function req(qs: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/image?${qs}`, { headers });
}

async function loginAs(plexUserId: string) {
  upsertUser({ plexUserId, username: plexUserId, email: null, thumb: null, isAdmin: false });
  await setSessionCookie(plexUserId);
}

/** Configure a Plex server so the route reaches the upstream fetch. */
function configurePlex() {
  setMediaServerType('plex');
  setServerField('plex', 'url', 'http://plex.local');
  setServerField('plex', 'token', 'server-token');
}

beforeEach(() => {
  cookieJar.clear();
  __setTestDbToMemory();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  __closeDb();
});

describe('GET /api/image auth guard', () => {
  it('401 without a session or key (the middleware-bypass case)', async () => {
    const res = await imageGet(req(`path=${PATH}`));
    expect(res.status).toBe(401);
  });

  it('401 with a bogus X-Api-Key header', async () => {
    setApiKey('the-real-key');
    const res = await imageGet(req(`path=${PATH}`, { 'x-api-key': 'garbage' }));
    expect(res.status).toBe(401);
  });

  it('passes auth with a valid session (503 when no server configured)', async () => {
    await loginAs('userA');
    const res = await imageGet(req(`path=${PATH}`));
    expect(res.status).toBe(503);
  });

  it('passes auth with a valid X-Api-Key header', async () => {
    setApiKey('the-real-key');
    const res = await imageGet(req(`path=${PATH}`, { 'x-api-key': 'the-real-key' }));
    expect(res.status).toBe(503);
  });
});

describe('GET /api/image hardening', () => {
  function mockImageFetch(contentType: string) {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': contentType },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('clamps oversized w/h before building the upstream URL', async () => {
    await loginAs('userA');
    configurePlex();
    const fetchMock = mockImageFetch('image/jpeg');
    const res = await imageGet(req(`path=${PATH}&w=99999&h=88888`));
    expect(res.status).toBe(200);
    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(calledUrl.searchParams.get('width')).toBe('1000');
    expect(calledUrl.searchParams.get('height')).toBe('1500');
  });

  it('never serves a non-image upstream content-type', async () => {
    await loginAs('userA');
    configurePlex();
    mockImageFetch('text/html');
    const res = await imageGet(req(`path=${PATH}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });
});
