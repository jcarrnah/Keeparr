/**
 * FORK: post-delete cleanup tests. Real in-memory SQLite for settings/logs (per
 * test conventions); only the two network-facing clients are mocked.
 */
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { __setTestDbToMemory, __closeDb } from './db';
import { recentLogs } from './queries';
import {
  setMediaServerType,
  setServerField,
  writeSetting,
  type MediaServerType,
} from './settings';
import { cleanupAfterDeletions, type PurgedItem } from './post-delete-cleanup';
import { refreshLibrary } from './jellyfin';
import { deleteSeerrRequest, seerrRequestIdsByExternalId } from './seerr';

vi.mock('./jellyfin', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./jellyfin')>();
  return { ...mod, refreshLibrary: vi.fn() };
});
vi.mock('./seerr', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./seerr')>();
  return {
    ...mod,
    seerrRequestIdsByExternalId: vi.fn(),
    deleteSeerrRequest: vi.fn(),
  };
});

const mockRefresh = vi.mocked(refreshLibrary);
const mockRequestMap = vi.mocked(seerrRequestIdsByExternalId);
const mockDeleteRequest = vi.mocked(deleteSeerrRequest);

beforeEach(() => {
  __setTestDbToMemory();
  vi.clearAllMocks();
  mockRequestMap.mockResolvedValue(new Map());
  mockRefresh.mockResolvedValue(undefined);
  mockDeleteRequest.mockResolvedValue(undefined);
});

afterAll(() => {
  __closeDb();
});

function configure(type: MediaServerType, opts: { seerr?: boolean } = {}) {
  setMediaServerType(type);
  setServerField(type, 'url', 'http://server');
  setServerField(type, 'token', 'tok');
  if (opts.seerr) {
    writeSetting('seerr_url', 'http://seerr');
    writeSetting('seerr_api_key', 'key');
  }
}

function item(over: Partial<PurgedItem> = {}): PurgedItem {
  return {
    ratingKey: '1',
    title: 'Murderbot',
    guidTmdb: null,
    guidTvdb: '443396',
    ...over,
  };
}

describe('FORK: cleanupAfterDeletions', () => {
  it('does nothing at all when no titles were purged (the dry-run path)', async () => {
    configure('jellyfin', { seerr: true });
    const res = await cleanupAfterDeletions([]);
    expect(res).toEqual({ seerrCleared: 0, serverRefreshed: false });
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockRequestMap).not.toHaveBeenCalled();
  });

  it('clears the Seerr request so the title cannot be re-downloaded', async () => {
    configure('jellyfin', { seerr: true });
    mockRequestMap.mockResolvedValue(new Map([['tvdb:443396', 77]]));

    const res = await cleanupAfterDeletions([item()]);

    expect(mockDeleteRequest).toHaveBeenCalledWith('http://seerr', 'key', 77);
    expect(res.seerrCleared).toBe(1);
  });

  it('resolves a CSV guid and never deletes the same request twice', async () => {
    configure('jellyfin', { seerr: true });
    mockRequestMap.mockResolvedValue(new Map([['tmdb:999', 5]]));

    const res = await cleanupAfterDeletions([
      item({ ratingKey: 'a', guidTmdb: '111,999', guidTvdb: null }),
      item({ ratingKey: 'b', guidTmdb: '999', guidTvdb: null }),
    ]);

    expect(mockDeleteRequest).toHaveBeenCalledTimes(1);
    expect(res.seerrCleared).toBe(1);
  });

  it('triggers one media-server rescan for the whole run', async () => {
    configure('emby', { seerr: false });
    const res = await cleanupAfterDeletions([item({ ratingKey: 'a' }), item({ ratingKey: 'b' })]);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(res.serverRefreshed).toBe(true);
  });

  it('skips the rescan on Plex (no equivalent refresh here)', async () => {
    configure('plex', { seerr: false });
    const res = await cleanupAfterDeletions([item()]);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(res.serverRefreshed).toBe(false);
  });

  it('skips Seerr entirely when it is not configured', async () => {
    configure('jellyfin', { seerr: false });
    await cleanupAfterDeletions([item()]);
    expect(mockRequestMap).not.toHaveBeenCalled();
    expect(mockDeleteRequest).not.toHaveBeenCalled();
  });

  it('warns but still rescans when Seerr fails — a purge must not be undone by it', async () => {
    configure('jellyfin', { seerr: true });
    mockRequestMap.mockResolvedValue(new Map([['tvdb:443396', 77]]));
    mockDeleteRequest.mockRejectedValue(new Error('boom'));

    const res = await cleanupAfterDeletions([item()]);

    expect(res.seerrCleared).toBe(0);
    expect(res.serverRefreshed).toBe(true); // the refresh still happened
    const warn = recentLogs({ level: 'warn' }).map((l) => l.message);
    expect(warn.some((m) => m.includes('could NOT clear its Seerr request'))).toBe(true);
  });

  it('never throws when the media server refresh fails', async () => {
    configure('jellyfin', { seerr: false });
    mockRefresh.mockRejectedValue(new Error('server down'));

    const res = await cleanupAfterDeletions([item()]);

    expect(res.serverRefreshed).toBe(false);
    const warn = recentLogs({ level: 'warn' }).map((l) => l.message);
    expect(warn.some((m) => m.includes('Could not trigger a media-server refresh'))).toBe(true);
  });
});
