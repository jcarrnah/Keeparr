import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from './http';

function fakeRes(opts: {
  ok?: boolean;
  status?: number;
  contentType?: string;
  body?: unknown;
}): Response {
  const { ok = true, status = 200, contentType, body } = opts;
  return {
    ok,
    status,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === 'content-type' ? contentType ?? null : null,
    },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe('fetchJson', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses a JSON response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeRes({ contentType: 'application/json', body: { hello: 'world' } })
    );
    await expect(fetchJson('http://x', { label: 'X' })).resolves.toEqual({
      hello: 'world',
    });
  });

  it('throws a clear error (not a JSON SyntaxError) on an HTML response', async () => {
    // The bug this guards: a wrong URL answering with an HTML login/error page.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeRes({ contentType: 'text/html', body: '<!DOCTYPE html><html/>' })
    );
    await expect(fetchJson('http://x', { label: 'Tautulli ping' })).rejects.toThrow(
      /Tautulli ping returned text\/html/i
    );
  });

  it('throws with the status on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeRes({ ok: false, status: 401, contentType: 'application/json' })
    );
    await expect(fetchJson('http://x', { label: 'Seerr /status' })).rejects.toThrow(
      /HTTP 401/
    );
  });

  it('maps an abort/timeout to a clear "timed out" error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation timed out.', 'TimeoutError')
    );
    await expect(
      fetchJson('http://x', { label: 'Plex ping', timeoutMs: 5 })
    ).rejects.toThrow(/Plex ping timed out/);
  });

  it('passes an AbortSignal for the timeout', async () => {
    const m = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeRes({ contentType: 'application/json', body: {} }));
    await fetchJson('http://x', { label: 'X' });
    expect(m).toHaveBeenCalledWith(
      'http://x',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('passes method + headers through', async () => {
    const m = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeRes({ contentType: 'application/json', body: {} }));
    await fetchJson('http://x', {
      label: 'X',
      method: 'POST',
      headers: { 'X-Api-Key': 'k' },
    });
    expect(m).toHaveBeenCalledWith(
      'http://x',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Api-Key': 'k', Accept: 'application/json' }),
      })
    );
  });
});
