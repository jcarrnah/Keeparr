/**
 * FORK: purge job tests. Real in-memory SQLite for storage (per test
 * conventions); only the network-facing arr client is mocked.
 */
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { __setTestDbToMemory, __closeDb } from './db';
import {
  dueDeletions,
  listScheduledDeletions,
  replaceArrItems,
  tagForDeletion,
  upsertMediaBatch,
  type UpsertMediaInput,
} from './queries';
import {
  setDeletionDryRun,
  setDeletionEnabled,
  setRadarrInstances,
} from './settings';
import { runPurge } from './purge';
import { deleteArrItem } from './arr';

vi.mock('./arr', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./arr')>();
  return { ...mod, deleteArrItem: vi.fn() };
});

const mockDelete = vi.mocked(deleteArrItem);

const GB = 1024 ** 3;
const past = Math.floor(Date.now() / 1000) - 100;

function media(ratingKey: string): UpsertMediaInput {
  return {
    ratingKey,
    sectionId: '1',
    libraryKind: 'movie',
    title: `Title ${ratingKey}`,
    year: 2020,
    thumb: null,
    sizeBytes: 2 * GB,
    addedAt: 1000,
    guidTmdb: null,
    guidTvdb: null,
  };
}

function arrMatch(ratingKey: string, arrId = 42) {
  replaceArrItems([
    {
      ratingKey,
      source: 'radarr' as const,
      instanceId: 'r1',
      instanceName: 'Radarr',
      arrId,
      monitored: true,
      status: 'released',
      quality: 'Bluray-1080p',
      qualityKind: 'file' as const,
      rootFolder: null,
      arrSizeBytes: 2 * GB,
      tags: [],
    },
  ]);
}

beforeEach(() => {
  __setTestDbToMemory();
  mockDelete.mockReset();
  mockDelete.mockResolvedValue(undefined);
  upsertMediaBatch([media('1'), media('2')]);
  setRadarrInstances([{ id: 'r1', name: 'Radarr', url: 'http://radarr', apiKey: 'k' }]);
});

afterAll(() => {
  __closeDb();
});

describe('FORK: runPurge', () => {
  it('does nothing while the master toggle is off (default)', async () => {
    tagForDeletion('1', 'admin', past);
    arrMatch('1');
    const res = await runPurge();
    expect(res.result).toBe(0);
    expect(res.message).toMatch(/disabled/i);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(listScheduledDeletions()[0].status).toBe('pending'); // untouched
  });

  it('dry run (default): reports but deletes nothing, tags stay pending', async () => {
    setDeletionEnabled(true); // dry-run left at its default (ON)
    tagForDeletion('1', 'admin', past);
    arrMatch('1');
    const res = await runPurge();
    expect(res.result).toBe(1);
    expect(res.message).toMatch(/DRY RUN/);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(listScheduledDeletions()[0].status).toBe('pending'); // retried next run
  });

  it('live mode deletes via the owning arr instance and records the outcome', async () => {
    setDeletionEnabled(true);
    setDeletionDryRun(false);
    tagForDeletion('1', 'admin', past);
    arrMatch('1', 42);
    const res = await runPurge();
    expect(res.result).toBe(1);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1' }),
      'radarr',
      42
    );
    const [row] = listScheduledDeletions();
    expect(row.status).toBe('deleted');
    expect(row.status_detail).toMatch(/radarr/);
  });

  it('an arr failure marks the tag failed (not deleted) and keeps going', async () => {
    setDeletionEnabled(true);
    setDeletionDryRun(false);
    tagForDeletion('1', 'admin', past);
    arrMatch('1');
    mockDelete.mockRejectedValueOnce(new Error('Radarr → HTTP 500'));
    const res = await runPurge();
    expect(res.result).toBe(0);
    expect(res.message).toMatch(/1 failed/);
    expect(listScheduledDeletions()[0].status).toBe('failed');
    expect(listScheduledDeletions()[0].status_detail).toMatch(/HTTP 500/);
  });

  it('unmatched items are reported, never deleted, and stay pending', async () => {
    setDeletionEnabled(true);
    setDeletionDryRun(false);
    tagForDeletion('1', 'admin', past); // no arr match at all
    const res = await runPurge();
    expect(res.result).toBe(0);
    expect(res.message).toMatch(/1 unmatched/);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(listScheduledDeletions()[0].status).toBe('pending');
  });

  it('a keep added after tagging holds the item through the purge', async () => {
    setDeletionEnabled(true);
    setDeletionDryRun(false);
    tagForDeletion('1', 'admin', past);
    arrMatch('1');
    // Raw keep (no applyKeep hold) — the purge's own reconcile must catch it.
    const { addKeep } = await import('./queries');
    addKeep('userA', '1');
    const res = await runPurge();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(res.message).toMatch(/1 newly held/);
    expect(listScheduledDeletions()[0].status).toBe('held');
    expect(dueDeletions()).toHaveLength(0);
  });
});
