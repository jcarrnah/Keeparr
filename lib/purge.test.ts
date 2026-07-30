/**
 * FORK: purge job tests. Real in-memory SQLite for storage (per test
 * conventions); only the network-facing arr client is mocked.
 */
import { beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { __setTestDbToMemory, __closeDb } from './db';
import {
  deletionResidueItems,
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
  setStorageMappings,
} from './settings';
import { runPurge } from './purge';
import { deleteArrItem } from './arr';
import { sendDiscordMessage } from './discord';

vi.mock('./arr', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./arr')>();
  return { ...mod, deleteArrItem: vi.fn() };
});
vi.mock('./discord', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./discord')>();
  return { ...mod, sendDiscordMessage: vi.fn() };
});

const mockDelete = vi.mocked(deleteArrItem);
const mockDiscord = vi.mocked(sendDiscordMessage);

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
  mockDiscord.mockReset();
  mockDiscord.mockResolvedValue(true);
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

  it('final-week Discord notice fires once per item (marked only when delivered)', async () => {
    setDeletionEnabled(true);
    const inFiveDays = Math.floor(Date.now() / 1000) + 5 * 86400;
    tagForDeletion('1', 'admin', inFiveDays);

    // First run: webhook down → not marked, retried next run.
    mockDiscord.mockResolvedValueOnce(false);
    await runPurge();
    expect(mockDiscord).toHaveBeenCalledWith(expect.stringContaining('Leaving in the next 7 days'));

    // Second run: delivered → marked; third run: no re-notice.
    await runPurge();
    const noticeCalls = () =>
      mockDiscord.mock.calls.filter(([msg]) => msg.includes('Leaving in the next 7 days')).length;
    expect(noticeCalls()).toBe(2);
    await runPurge();
    expect(noticeCalls()).toBe(2); // no third notice
  });

  it('live purge sends a summary; dry run stays quiet', async () => {
    setDeletionEnabled(true);
    tagForDeletion('1', 'admin', past);
    arrMatch('1');
    await runPurge(); // dry run (default)
    expect(
      mockDiscord.mock.calls.some(([msg]) => msg.includes('Purge complete'))
    ).toBe(false);

    setDeletionDryRun(false);
    await runPurge();
    expect(
      mockDiscord.mock.calls.some(([msg]) => msg.includes('Purge complete'))
    ).toBe(true);
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

// ---------------------------------------------------------------------------
// FORK: post-delete disk verification. Uses a REAL temp directory — the whole
// point is measuring the filesystem, so mocking fs would test nothing.
// ---------------------------------------------------------------------------

describe('FORK: purge verifies the bytes actually left the disk', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(join(tmpdir(), 'keeparr-purge-'));
    setDeletionEnabled(true);
    setDeletionDryRun(false);
    setRadarrInstances([{ id: 'r1', name: 'Radarr', url: 'http://r', apiKey: 'k' }]);
    mockDelete.mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  /** Tag one movie whose on-disk folder is `dirName` under the mapped root. */
  function tagWithFolder(dirName: string) {
    upsertMediaBatch([{ ...media('1'), dirName }]);
    arrMatch('1');
    setStorageMappings([{ sectionId: '1', path: root }]);
    tagForDeletion('1', 'admin', past);
  }

  it('reports the FULL size as freed when the folder really is gone', async () => {
    tagWithFolder('Title 1'); // never created on disk = already gone
    const res = await runPurge();

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(res.message).toMatch(/freed 2\.00 GB/);
    expect(res.message).not.toMatch(/still on disk/);
    expect(listScheduledDeletions()[0].residue_bytes).toBe(0);
  });

  it('subtracts leftovers from the freed figure and flags them', async () => {
    // *arr removed the media but left artwork/subs behind.
    await fsp.mkdir(join(root, 'Title 1'), { recursive: true });
    await fsp.writeFile(join(root, 'Title 1', 'poster.jpg'), Buffer.alloc(2048));
    await fsp.writeFile(join(root, 'Title 1', 'Title 1.srt'), Buffer.alloc(1024));
    tagWithFolder('Title 1');

    const res = await runPurge();

    const row = listScheduledDeletions()[0];
    expect(row.status).toBe('deleted'); // the *arr delete still succeeded
    expect(row.residue_bytes).toBe(3072);
    expect(res.message).toMatch(/1 left files behind/);
    expect(res.message).toMatch(/still on disk/);
    // The reported figure is measured, not the server's 2 GB claim.
    expect(res.message).toMatch(/2\.00 GB expected/);
    expect(deletionResidueItems()).toEqual([
      expect.objectContaining({ ratingKey: '1', residueBytes: 3072 }),
    ]);
  });

  it('records "unverified" rather than success when the section is unmapped', async () => {
    upsertMediaBatch([{ ...media('1'), dirName: 'Title 1' }]);
    arrMatch('1');
    setStorageMappings([]); // no mapping → cannot verify
    tagForDeletion('1', 'admin', past);

    const res = await runPurge();

    expect(res.message).toMatch(/1 unverified/);
    // NULL, not 0 — "we don't know" must not read as "confirmed gone".
    expect(listScheduledDeletions()[0].residue_bytes).toBeNull();
    expect(deletionResidueItems()).toEqual([]);
  });

  it('does not touch the disk in dry-run', async () => {
    await fsp.mkdir(join(root, 'Title 1'), { recursive: true });
    await fsp.writeFile(join(root, 'Title 1', 'movie.mkv'), Buffer.alloc(4096));
    tagWithFolder('Title 1');
    setDeletionDryRun(true);

    const res = await runPurge();

    expect(mockDelete).not.toHaveBeenCalled();
    expect(res.message).toMatch(/DRY RUN/);
    expect(listScheduledDeletions()[0].residue_bytes).toBeNull(); // never verified
  });
});
