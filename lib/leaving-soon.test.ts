/**
 * FORK: Leaving Soon collection sync tests. Real in-memory SQLite; only the
 * network-facing jellyfin client is mocked (per test conventions).
 */
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { __setTestDbToMemory, __closeDb } from './db';
import { tagForDeletion, upsertMediaBatch, type UpsertMediaInput } from './queries';
import {
  setLeavingSoonEnabled,
  setMediaServerType,
  setServerField,
} from './settings';
import { syncLeavingSoonCollection } from './leaving-soon';
import {
  addToCollection,
  createCollection,
  findCollectionByName,
  getCollectionItemIds,
  removeFromCollection,
} from './jellyfin';

vi.mock('./jellyfin', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./jellyfin')>();
  return {
    ...mod,
    findCollectionByName: vi.fn(),
    createCollection: vi.fn(),
    getCollectionItemIds: vi.fn(),
    addToCollection: vi.fn(),
    removeFromCollection: vi.fn(),
  };
});

const mFind = vi.mocked(findCollectionByName);
const mCreate = vi.mocked(createCollection);
const mItems = vi.mocked(getCollectionItemIds);
const mAdd = vi.mocked(addToCollection);
const mRemove = vi.mocked(removeFromCollection);

const future = Math.floor(Date.now() / 1000) + 30 * 86400;

function media(ratingKey: string): UpsertMediaInput {
  return {
    ratingKey,
    sectionId: '1',
    libraryKind: 'movie',
    title: `Title ${ratingKey}`,
    year: 2020,
    thumb: null,
    sizeBytes: 1,
    addedAt: 1000,
    guidTmdb: null,
    guidTvdb: null,
  };
}

function configureJellyfin() {
  setMediaServerType('jellyfin');
  setServerField('jellyfin', 'url', 'http://jf.local');
  setServerField('jellyfin', 'token', 'tok');
  setServerField('jellyfin', 'adminToken', 'admintok');
}

beforeEach(() => {
  __setTestDbToMemory();
  vi.clearAllMocks();
  mAdd.mockResolvedValue(undefined);
  mRemove.mockResolvedValue(undefined);
  upsertMediaBatch([media('a'), media('b'), media('c')]);
});

afterAll(() => {
  __closeDb();
});

describe('FORK: syncLeavingSoonCollection', () => {
  it('is a no-op on Plex (the default backend) and when toggled off', async () => {
    tagForDeletion('a', 'admin', future);
    expect(await syncLeavingSoonCollection()).toBeNull(); // plex default

    configureJellyfin();
    setLeavingSoonEnabled(false);
    expect(await syncLeavingSoonCollection()).toBeNull();
    expect(mFind).not.toHaveBeenCalled();
  });

  it('creates the collection EMPTY then chunk-adds (a seeded create URL 414s)', async () => {
    configureJellyfin();
    tagForDeletion('a', 'admin', future);
    tagForDeletion('b', 'admin', future);
    mFind.mockResolvedValue(null);
    mCreate.mockResolvedValue('col-1');

    const msg = await syncLeavingSoonCollection();
    expect(msg).toMatch(/\+2\/-0 \(2 total\)/);
    expect(mCreate).toHaveBeenCalledWith('http://jf.local', 'admintok', 'Leaving Soon');
    expect(mAdd).toHaveBeenCalledWith(
      'http://jf.local',
      'admintok',
      'col-1',
      expect.arrayContaining(['a', 'b'])
    );

    // Second run: cached id used, no re-find/create; diff is a no-op.
    mItems.mockResolvedValue(['a', 'b']);
    const msg2 = await syncLeavingSoonCollection();
    expect(msg2).toMatch(/\+0\/-0 \(2 total\)/);
    expect(mFind).toHaveBeenCalledTimes(1);
    expect(mCreate).toHaveBeenCalledTimes(1);
  });

  it('diffs the collection: adds new pending, removes rescued/purged', async () => {
    configureJellyfin();
    tagForDeletion('a', 'admin', future); // pending
    tagForDeletion('b', 'admin', future); // pending
    mFind.mockResolvedValue('col-9');
    mItems.mockResolvedValue(['b', 'c']); // c no longer pending; a missing

    const msg = await syncLeavingSoonCollection();
    expect(msg).toMatch(/\+1\/-1 \(2 total\)/);
    expect(mAdd).toHaveBeenCalledWith('http://jf.local', 'admintok', 'col-9', ['a']);
    expect(mRemove).toHaveBeenCalledWith('http://jf.local', 'admintok', 'col-9', ['c']);
  });

  it('held items are NOT in the collection (only pending)', async () => {
    configureJellyfin();
    tagForDeletion('a', 'admin', future);
    tagForDeletion('b', 'admin', future);
    const { applyKeep } = await import('./queries');
    applyKeep('userA', 'b'); // → held
    mFind.mockResolvedValue('col-9');
    mItems.mockResolvedValue(['a', 'b']);

    const msg = await syncLeavingSoonCollection();
    expect(msg).toMatch(/\+0\/-1 \(1 total\)/);
    expect(mRemove).toHaveBeenCalledWith('http://jf.local', 'admintok', 'col-9', ['b']);
  });

  it('a media-server failure degrades to a warning, never throws', async () => {
    configureJellyfin();
    tagForDeletion('a', 'admin', future);
    mFind.mockRejectedValue(new Error('JF down'));
    const msg = await syncLeavingSoonCollection();
    expect(msg).toMatch(/sync failed/);
  });
});
