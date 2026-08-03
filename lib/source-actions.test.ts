/**
 * FORK: tests for the Problems page's "fix it at the source" actions. Real
 * in-memory SQLite for storage (per test conventions); only the network-facing
 * clients (arr / jellyfin) are mocked.
 *
 * The one that matters most is the stale-record gate: this is the only action
 * in the fork's Problems surface that removes anything, and its whole
 * justification is "the disk scan says the folder isn't there".
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __closeDb, __setTestDbToMemory } from './db';
import {
  getArrUnmatched,
  replaceArrItems,
  replaceArrUnmatched,
  updateArrUnmatchedDisk,
  upsertMediaBatch,
  type UpsertMediaInput,
} from './queries';
import {
  setRadarrInstances,
  setSonarrInstances,
  writeSetting,
} from './settings';
import { refreshArrItem, removeArrRecord, rescanArrItem } from './arr';
import { refreshItem } from './jellyfin';
import {
  arrScanMediaItems,
  arrScanUnmatched,
  refreshServerItems,
  removeStaleArrRecords,
  sourceLinksFor,
} from './source-actions';

vi.mock('./arr', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./arr')>();
  return {
    ...mod,
    rescanArrItem: vi.fn(),
    refreshArrItem: vi.fn(),
    removeArrRecord: vi.fn(),
  };
});
vi.mock('./jellyfin', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./jellyfin')>();
  return { ...mod, refreshItem: vi.fn() };
});

const mockRescan = vi.mocked(rescanArrItem);
const mockRefresh = vi.mocked(refreshArrItem);
const mockRemove = vi.mocked(removeArrRecord);
const mockItemRefresh = vi.mocked(refreshItem);

const GB = 1024 ** 3;

function media(ratingKey: string, title = `Title ${ratingKey}`): UpsertMediaInput {
  return {
    ratingKey,
    sectionId: '1',
    libraryKind: 'movie',
    title,
    year: 2020,
    thumb: null,
    sizeBytes: 2 * GB,
    addedAt: 1000,
    guidTmdb: null,
    guidTvdb: null,
  };
}

/** Match one or more media items to Radarr. `replaceArrItems` rewrites the
 *  whole table, so every title that should be matched goes in one call. */
function arrMatch(
  keys: string | string[],
  over: Partial<{ arrId: number; titleSlug: string }> = {}
) {
  const list = Array.isArray(keys) ? keys : [keys];
  replaceArrItems(
    list.map((ratingKey, i) => ({
      ratingKey,
      source: 'radarr' as const,
      instanceId: 'r1',
      instanceName: 'Radarr',
      arrId: (over.arrId ?? 42) + i,
      monitored: true,
      status: 'released',
      quality: 'Bluray-1080p',
      qualityKind: 'file' as const,
      rootFolder: null,
      arrSizeBytes: 2 * GB,
      tags: [],
      titleSlug: over.titleSlug ?? 'the-movie-123',
    }))
  );
}

/** One unmatched Sonarr title; `onDisk` mirrors what the disk scan concluded. */
function unmatched(extId: string, onDisk: boolean | null, arrId: number | null = 7) {
  replaceArrUnmatched([
    {
      source: 'sonarr',
      instanceId: 's1',
      instanceName: 'Sonarr',
      title: `Show ${extId}`,
      extKind: 'tvdb',
      extId,
      sizeBytes: 3 * GB,
      folderName: `Show ${extId}`,
      path: `/tv/Show ${extId}`,
      arrId,
      titleSlug: `show-${extId}`,
    },
  ]);
  if (onDisk !== null) {
    updateArrUnmatchedDisk([
      { instanceId: 's1', extKind: 'tvdb', extId, onDisk, diskSizeBytes: onDisk ? GB : null },
    ]);
  }
}

const key = (extId: string) => `s1|tvdb|${extId}`;

beforeEach(() => {
  __setTestDbToMemory();
  for (const m of [mockRescan, mockRefresh, mockRemove, mockItemRefresh]) {
    m.mockReset();
    m.mockResolvedValue(undefined);
  }
  setRadarrInstances([{ id: 'r1', name: 'Radarr', url: 'http://radarr:7878', apiKey: 'k' }]);
  setSonarrInstances([{ id: 's1', name: 'Sonarr', url: 'http://sonarr:8989/', apiKey: 'k' }]);
  writeSetting('media_server_type', 'jellyfin');
  writeSetting('jellyfin_url', 'http://jellyfin:8096');
  writeSetting('jellyfin_admin_token', 'tok');
});

afterAll(() => {
  __closeDb();
});

describe('FORK: *arr scans from the Problems page', () => {
  it('rescans one command per matched title, and says what it skipped', async () => {
    upsertMediaBatch([media('1'), media('2')]);
    arrMatch('1');
    const res = await arrScanMediaItems(['1', '2'], 'rescan');
    expect(mockRescan).toHaveBeenCalledTimes(1);
    expect(mockRescan.mock.calls[0][1]).toBe('radarr');
    expect(mockRescan.mock.calls[0][2]).toBe(42);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/1 title/);
    expect(res.message).toMatch(/1 skipped/); // '2' has no arr match
    // The *arr works asynchronously, so there is nothing to refetch yet.
    expect(res.changed).toBe(0);
  });

  it('refresh mode calls the metadata command instead', async () => {
    upsertMediaBatch([media('1')]);
    arrMatch('1');
    await arrScanMediaItems(['1'], 'refresh');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRescan).not.toHaveBeenCalled();
  });

  it('one failing title does not sink the rest of the batch', async () => {
    upsertMediaBatch([media('1'), media('2'), media('3')]);
    arrMatch(['1', '2', '3']);
    mockRescan.mockRejectedValueOnce(new Error('Radarr down')); // only the first
    const res = await arrScanMediaItems(['1', '2', '3'], 'rescan');
    expect(mockRescan).toHaveBeenCalledTimes(3); // it kept going
    expect(res.ok).toBe(false); // …and still reports the failure
    expect(res.message).toMatch(/2 titles/);
    expect(res.message).toMatch(/1 failed/);
  });

  it('rescans unmatched *arr titles by their own ids', async () => {
    unmatched('100', true);
    const res = await arrScanUnmatched([key('100')], 'rescan');
    expect(mockRescan).toHaveBeenCalledTimes(1);
    expect(mockRescan.mock.calls[0][1]).toBe('sonarr');
    expect(mockRescan.mock.calls[0][2]).toBe(7);
    expect(res.ok).toBe(true);
  });
});

describe('FORK: removing a stale *arr record', () => {
  it('removes only records whose folder the disk scan could not find', async () => {
    unmatched('100', false); // folder confirmed missing → eligible
    const res = await removeStaleArrRecords([key('100')]);
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockRemove.mock.calls[0][2]).toBe(7);
    expect(res.changed).toBe(1);
    expect(res.message).toMatch(/No files were deleted/);
    // and the row goes, so the table stops listing a title that's gone
    expect(getArrUnmatched(false)).toHaveLength(0);
  });

  it('refuses a row the disk scan says IS on disk', async () => {
    unmatched('101', true);
    const res = await removeStaleArrRecords([key('101')]);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(res.changed).toBe(0);
    expect(res.message).toMatch(/skipped/);
    expect(getArrUnmatched(false)).toHaveLength(1);
  });

  it('refuses an UNVERIFIED row — unknown is not the same as absent', async () => {
    unmatched('102', null);
    const res = await removeStaleArrRecords([key('102')]);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(getArrUnmatched(false)).toHaveLength(1);
  });

  it('refuses a row with no *arr id to act on', async () => {
    unmatched('103', false, null);
    const res = await removeStaleArrRecords([key('103')]);
    expect(mockRemove).not.toHaveBeenCalled();
    expect(res.changed).toBe(0);
  });

  it('keeps the local row when the *arr call fails', async () => {
    unmatched('104', false);
    mockRemove.mockRejectedValueOnce(new Error('Sonarr down'));
    const res = await removeStaleArrRecords([key('104')]);
    expect(res.ok).toBe(false);
    expect(res.changed).toBe(0);
    expect(getArrUnmatched(false)).toHaveLength(1); // still there to retry
  });
});

describe('FORK: media-server item refresh', () => {
  it('re-identifies items (full refresh) when asked', async () => {
    const res = await refreshServerItems(['1', '2'], { reidentify: true });
    expect(mockItemRefresh).toHaveBeenCalledTimes(2);
    expect(mockItemRefresh.mock.calls[0][3]).toEqual({ reidentify: true });
    expect(res.message).toMatch(/re-identify/);
    expect(res.changed).toBe(0); // asynchronous server-side
  });

  it('is a no-op on Plex, and says so rather than failing silently', async () => {
    writeSetting('media_server_type', 'plex');
    const res = await refreshServerItems(['1']);
    expect(mockItemRefresh).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Jellyfin\/Emby/);
  });
});

describe('FORK: source links', () => {
  it('links a matched item to its *arr and to the server', () => {
    upsertMediaBatch([media('1')]);
    arrMatch('1', { titleSlug: 'the-movie-123' });
    const links = sourceLinksFor({ ratingKeys: ['1'] });
    expect(links['1'].arr?.url).toBe('http://radarr:7878/movie/the-movie-123');
    expect(links['1'].server?.url).toContain('/web/#/details?id=1');
  });

  it('uses the series route for Sonarr and trims the instance URL', () => {
    unmatched('100', false);
    const links = sourceLinksFor({ unmatchedKeys: [key('100')] });
    // instance URL was stored with a trailing slash
    expect(links[key('100')].arr?.url).toBe('http://sonarr:8989/series/show-100');
    // nothing to open on the server — that's the whole problem with these rows
    expect(links[key('100')].server).toBeUndefined();
  });

  it('offers no *arr link until a slug has been synced', () => {
    upsertMediaBatch([media('1')]);
    replaceArrItems([
      {
        ratingKey: '1',
        source: 'radarr',
        instanceId: 'r1',
        instanceName: 'Radarr',
        arrId: 42,
        monitored: true,
        status: 'released',
        quality: null,
        qualityKind: 'file',
        rootFolder: null,
        arrSizeBytes: 0,
        tags: [],
      },
    ]);
    expect(sourceLinksFor({ ratingKeys: ['1'] })['1'].arr).toBeUndefined();
  });
});
