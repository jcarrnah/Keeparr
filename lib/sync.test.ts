import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { __setTestDbToMemory, __closeDb } from './db';
import {
  getArrUnmatched,
  getMediaItem,
  libraryStats,
  replaceArrItems,
  replaceArrUnmatched,
  upsertMediaBatch,
  queryLibrary,
  type UpsertMediaInput,
} from './queries';
import {
  getPlexSections,
  setManagedSectionIds,
  setPlexSections,
  setRadarrInstances,
  setSonarrInstances,
  writeSetting,
} from './settings';
import type { BackendItem, BackendSection, MediaBackend } from './mediaserver';
import { fetchSonarr, fetchRadarr, type ArrRecord } from './arr';
import { syncArr, syncLibrary } from './sync';

// The sync engine reads through getBackend() (the seam, not storage) — swap in
// a per-test fake. The factory closure reads `fakeBackend` lazily at run time.
let fakeBackend: MediaBackend;
vi.mock('./mediaserver', () => ({ getBackend: () => fakeBackend }));

// Network clients are mocked (never storage); everything below them is real.
vi.mock('./arr', () => ({ fetchSonarr: vi.fn(), fetchRadarr: vi.fn() }));

const GB = 1024 ** 3;

function section(id: string, kind: 'movie' | 'show' = 'movie'): BackendSection {
  return { id, title: `Lib ${id}`, kind, paths: [`/media/${id}`] };
}

function backendItem(ratingKey: string, over: Partial<BackendItem> = {}): BackendItem {
  return {
    ratingKey,
    title: `Title ${ratingKey}`,
    year: 2020,
    thumb: null,
    addedAt: 1000,
    guidTmdb: null,
    guidTvdb: null,
    guidImdb: null,
    sizeBytes: 1 * GB,
    ...over,
  };
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

function backendWith(
  sections: BackendSection[],
  itemsBySection: Record<string, BackendItem[]>
): MediaBackend {
  return {
    listSections: async () => sections,
    listSectionItems: async (id) => itemsBySection[id] ?? [],
    recentItems: async () => [],
    showSize: async () => 0,
    getWatchData: async () => null,
  };
}

beforeEach(() => {
  __setTestDbToMemory();
  // Real settings rows (not mocks) so isServerConfigured() passes as Plex.
  writeSetting('plex_machine_id', 'abc');
  writeSetting('plex_base_url', 'http://plex:32400');
  writeSetting('plex_server_token', 't');
  vi.mocked(fetchSonarr).mockReset();
  vi.mocked(fetchRadarr).mockReset();
});

afterAll(() => {
  __closeDb();
});

describe('syncLibrary tombstone guards', () => {
  it('aborts on zero sections without touching stored sections or media', async () => {
    setPlexSections([{ id: '1', title: 'Movies', type: 'movie', paths: ['/data/movies'] }]);
    upsertMediaBatch([media('1')], 1000);
    fakeBackend = backendWith([], {});
    await expect(syncLibrary()).rejects.toThrow(/no library sections/);
    // The sections blob (incl. paths for storage mapping) was not overwritten…
    expect(getPlexSections()).toEqual([
      { id: '1', title: 'Movies', type: 'movie', paths: ['/data/movies'] },
    ]);
    // …and nothing was tombstoned.
    expect(getMediaItem('1')?.removed).toBe(0);
  });

  it('an empty-but-200 section keeps its rows; a scanned section still tombstones', async () => {
    // Section 1 previously had items 1+2; section 2 had item 3.
    upsertMediaBatch([media('1'), media('2')], 1000);
    upsertMediaBatch([media('3', { sectionId: '2' })], 1000);
    // This scan: section 1 returns only item 1 (item 2 genuinely deleted);
    // section 2 answers 200 with no items (backend hiccup).
    fakeBackend = backendWith([section('1'), section('2')], {
      '1': [backendItem('1')],
      '2': [],
    });
    const res = await syncLibrary();
    expect(getMediaItem('1')?.removed).toBe(0);
    expect(getMediaItem('2')?.removed).toBe(1); // real deletion still detected
    expect(getMediaItem('3')?.removed).toBe(0); // shielded by the empty-section guard
    expect(res.message).toContain('1 section(s) returned no items');
  });

  it('unmanaged sections still tombstone out (intentional behavior)', async () => {
    upsertMediaBatch([media('1'), media('9', { sectionId: '9' })], 1000);
    setManagedSectionIds(['1']);
    fakeBackend = backendWith([section('1'), section('9')], {
      '1': [backendItem('1')],
      '9': [backendItem('9')], // discovered but unmanaged → never scanned
    });
    await syncLibrary();
    expect(getMediaItem('1')?.removed).toBe(0);
    expect(getMediaItem('9')?.removed).toBe(1); // dropped out as before
  });
});

describe('syncArr per-instance replace', () => {
  const rec = (over: Partial<ArrRecord>): ArrRecord => ({
    source: 'radarr',
    instanceId: 'r1',
    instanceName: 'Radarr',
    arrId: 1,
    matchId: '22',
    imdbId: null,
    title: 'Movie',
    monitored: true,
    status: 'released',
    quality: 'Bluray-1080p',
    qualityKind: 'file',
    rootFolder: '/m',
    sizeOnDisk: 1 * GB,
    tags: [],
    ...over,
  });

  const arrSource = (ratingKey: string) =>
    queryLibrary({ plexUserId: 'u', limit: 100, offset: 0 }).find(
      (r) => r.rating_key === ratingKey
    )?.arr_source ?? null;

  beforeEach(() => {
    setSonarrInstances([{ id: 's1', name: 'Sonarr', url: 'http://s1', apiKey: 'k' }]);
    setRadarrInstances([{ id: 'r1', name: 'Radarr', url: 'http://r1', apiKey: 'k' }]);
    upsertMediaBatch([
      media('m1', { guidTmdb: '22' }),
      media('sh1', { libraryKind: 'show', guidTvdb: '11' }),
    ]);
    // Prior run cached rows for both instances.
    replaceArrItems([
      {
        ratingKey: 'sh1', source: 'sonarr', instanceId: 's1', instanceName: 'Sonarr',
        arrId: 1, monitored: true, status: 'ended', quality: 'HD-1080p',
        qualityKind: 'profile', rootFolder: '/tv', arrSizeBytes: 1 * GB, tags: [],
      },
    ]);
    replaceArrUnmatched([
      { source: 'sonarr', instanceId: 's1', instanceName: 'Sonarr', title: 'Orphan', extKind: 'tvdb', extId: '99', sizeBytes: 500 },
    ]);
  });

  it('keeps a failed instance\'s cached rows while refreshing the healthy one', async () => {
    vi.mocked(fetchSonarr).mockRejectedValue(new Error('down'));
    vi.mocked(fetchRadarr).mockResolvedValue([rec({})]);
    const res = await syncArr();
    expect(arrSource('m1')).toBe('radarr'); // fresh
    expect(arrSource('sh1')).toBe('sonarr'); // preserved despite the failure
    expect(getArrUnmatched().map((u) => u.title)).toEqual(['Orphan']); // preserved
    expect(res.message).toContain('1 instance error(s); their cached data kept');
  });

  it('keeps the whole cache when every instance fails', async () => {
    vi.mocked(fetchSonarr).mockRejectedValue(new Error('down'));
    vi.mocked(fetchRadarr).mockRejectedValue(new Error('down'));
    const res = await syncArr();
    expect(res.message).toContain('kept existing cache');
    expect(arrSource('sh1')).toBe('sonarr');
    expect(getArrUnmatched()).toHaveLength(1);
  });

  it('a fully successful run still replaces wholesale', async () => {
    vi.mocked(fetchSonarr).mockResolvedValue([]);
    vi.mocked(fetchRadarr).mockResolvedValue([rec({})]);
    await syncArr();
    expect(arrSource('m1')).toBe('radarr');
    expect(arrSource('sh1')).toBeNull(); // Sonarr reported nothing → row dropped
    expect(getArrUnmatched()).toEqual([]); // stale orphan swept
  });
});
