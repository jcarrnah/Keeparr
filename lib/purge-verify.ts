/**
 * FORK: post-delete reality check.
 *
 * The purge job asks Sonarr/Radarr to delete a title with `deleteFiles=true`
 * and then reports `media_items.size_bytes` as "reclaimed". That figure is the
 * size the MEDIA SERVER last reported — it is assumed, never measured. In
 * practice a delete can leave real bytes behind: artwork/`.nfo`, manually added
 * subtitles, `Extras/`/`Featurettes/` subfolders, or a download-client copy
 * living under the same library root. The folder then belongs to nobody (the
 * *arr record is gone and the server item gets tombstoned), so it resurfaces
 * later as a "On disk, in neither" disk orphan — long after the purge claimed
 * the space back.
 *
 * This measures the folder immediately after the delete, so the purge can
 * report what actually left the disk.
 *
 * Lives in its own module rather than inside `lib/diskscan.ts` (upstream-owned,
 * actively developed) — see FORK_SYNC.md. It reuses upstream's exported
 * `sizeOfDir` walker and `normalizeName`, and keeps only the small bits of root
 * listing it needs.
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { sizeOfDir } from './diskscan';
import { normalizeName } from './paths';
import { getStorageMappings } from './settings';

/** What a post-delete check found under the mapped library root. */
export interface DeletionVerification {
  /** Something matching the item's name(s) is STILL on disk. */
  found: boolean;
  /** Bytes still occupied (0 when nothing is left). */
  residueBytes: number;
}

/**
 * A verifier bound to the current storage mappings. Returns null when
 * verification isn't possible (no mappings configured, or this item's section
 * isn't mapped / its root is unreadable), which callers must treat as
 * "unknown", never as "successfully deleted".
 *
 * Roots are deliberately NOT cached between calls: the purge deletes and
 * verifies one item at a time, so a listing taken before a later delete would
 * still contain that item and report phantom residue.
 */
export function createDeletionVerifier(): {
  verify: (
    sectionId: string,
    dirNames: string[],
    fileName: string | null
  ) => Promise<DeletionVerification | null>;
} {
  const rootBySection = new Map(
    getStorageMappings()
      .filter((m) => m.path && m.path.trim())
      .map((m) => [m.sectionId, m.path])
  );

  /** Top-level entries of one root, indexed by normalized name (case/spacing
   *  differences are common between what the server reports and the disk). */
  const listRoot = async (path: string) => {
    try {
      const entries = await fsp.readdir(path, { withFileTypes: true });
      const map = new Map<string, { abs: string; isDir: boolean }>();
      for (const e of entries) {
        map.set(normalizeName(e.name), {
          abs: join(path, e.name),
          isDir: e.isDirectory(),
        });
      }
      return map;
    } catch {
      return null; // unreadable root — can't verify anything here
    }
  };

  const sizeEntry = async (entry: { abs: string; isDir: boolean }) => {
    if (entry.isDir) return sizeOfDir(entry.abs);
    try {
      return (await fsp.lstat(entry.abs)).size;
    } catch {
      return 0;
    }
  };

  return {
    async verify(sectionId, dirNames, fileName) {
      const root = rootBySection.get(sectionId);
      if (!root) return null; // section not mapped to a container path
      const listing = await listRoot(root);
      if (!listing) return null; // root unreadable

      // A show's dir_name is newline-joined when it spans several folders —
      // callers split it; every folder has to be checked.
      const names = [...dirNames];
      if (fileName) names.push(fileName);
      if (names.length === 0) return null; // nothing captured to look for

      let residueBytes = 0;
      let found = false;
      for (const name of names) {
        const entry = listing.get(normalizeName(name));
        if (!entry) continue;
        found = true;
        residueBytes += await sizeEntry(entry);
      }

      return { found, residueBytes };
    },
  };
}
