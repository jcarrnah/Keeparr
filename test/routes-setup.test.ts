import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const { getPublicServerInfo } = vi.hoisted(() => ({
  getPublicServerInfo: vi.fn(async () => ({ id: 'srv1', name: 'Test JF' })),
}));
vi.mock('@/lib/jellyfin', () => ({ getPublicServerInfo }));

import { __setTestDbToMemory, __closeDb } from '@/lib/db';
import { POST as setupPost } from '@/app/api/auth/setup/route';

function setup(body: unknown): Promise<Response> {
  return setupPost(
    new Request('http://localhost/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  __setTestDbToMemory();
  getPublicServerInfo.mockClear();
});
afterAll(() => {
  __closeDb();
});

describe('POST /api/auth/setup URL validation', () => {
  it('rejects a non-HTTP scheme before probing', async () => {
    const res = await setup({ type: 'jellyfin', url: 'file:///etc/passwd' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_url' });
    expect(getPublicServerInfo).not.toHaveBeenCalled();
  });

  it('rejects an unparseable URL', async () => {
    const res = await setup({ type: 'jellyfin', url: 'not a url' });
    expect(res.status).toBe(400);
    expect(getPublicServerInfo).not.toHaveBeenCalled();
  });

  it('accepts an http(s) URL and probes it (private LAN IP allowed)', async () => {
    const res = await setup({ type: 'jellyfin', url: 'http://192.168.1.50:8096' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(getPublicServerInfo).toHaveBeenCalledOnce();
  });
});
