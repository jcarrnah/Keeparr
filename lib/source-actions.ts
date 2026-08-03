/**
 * FORK: act on a problem where it actually lives — in Sonarr/Radarr or on the
 * media server — rather than only in Keeparr's own bookkeeping.
 *
 * The Problems page is good at finding disagreements and was, until now, mostly
 * able to tell you about them: its fix-its re-linked keeps, re-walked disks and
 * kicked off a whole-library rescan. But almost every row's real fix lives in
 * another app — "make Sonarr look at that folder again", "make Jellyfin
 * re-identify this item so it finally has a tmdb id", "this *arr record points
 * at a folder that isn't there". Each of those is one API call away, and making
 * the operator go and find the title in a second app is how a Problems list
 * turns into a list you stop reading.
 *
 * Rules this module keeps:
 * - **Nothing here deletes media.** The one removal is a *arr RECORD whose
 *   folder the disk scan could not find, sent with `deleteFiles=false`, and the
 *   "not on disk" check is re-read from the database here — never taken from
 *   the request — so a stale or hand-edited client can't turn it into a delete.
 * - **Per-title failures don't sink the batch.** Each call is caught, counted
 *   and named in the summary; the *arr being briefly down should cost you that
 *   title, not the other nine.
 * - The commands are queued, not synchronous: a "started" result means the *arr
 *   accepted the command, so callers must not refetch and expect new numbers.
 */
import {
  refreshArrItem,
  removeArrRecord,
  rescanArrItem,
  type ArrSource,
} from './arr';
import { refreshItem } from './jellyfin';
import {
  arrActionTargets,
  deleteArrUnmatchedRow,
  getArrUnmatched,
  logEvent,
  type ArrUnmatchedRow,
} from './queries';
import {
  getAdminToken,
  getMediaServerType,
  getRadarrInstances,
  getServerBaseUrl,
  getServerToken,
  getSonarrInstances,
  type ArrInstance,
} from './settings';

export interface SourceActionResult {
  ok: boolean;
  /** Sentence for the toast — says what happened, including what didn't. */
  message: string;
  /** Rows the caller should expect to have changed (0 = don't refetch). */
  changed: number;
}

/** One title to act on in its *arr. */
interface ArrTarget {
  title: string;
  source: string;
  instanceId: string;
  arrId: number | null;
}

/** The instance that owns a target, or null when it's no longer configured. */
function instanceFor(source: string, instanceId: string): ArrInstance | null {
  const pool = source === 'radarr' ? getRadarrInstances() : getSonarrInstances();
  return pool.find((i) => i.id === instanceId) ?? null;
}

/** Key an unmatched row the way the client refers to it (no id column to use). */
export function unmatchedKey(r: {
  instanceId: string;
  extKind: string;
  extId: string;
}): string {
  return `${r.instanceId}|${r.extKind}|${r.extId}`;
}

/**
 * Queue a rescan (files) or refresh (metadata) for each target, one command per
 * title — the singular/plural fields differ between Sonarr and Radarr and
 * between *arr versions, so a batch command is the thing most likely to
 * silently act on only the first title.
 */
async function runArrCommands(
  targets: ArrTarget[],
  mode: 'rescan' | 'refresh',
  source: string
): Promise<SourceActionResult> {
  const actionable = targets.filter((t) => t.arrId != null);
  const notInArr = targets.length - actionable.length;
  let done = 0;
  const failures: string[] = [];

  for (const t of actionable) {
    const inst = instanceFor(t.source, t.instanceId);
    if (!inst) {
      failures.push(`${t.title} (its instance is no longer configured)`);
      continue;
    }
    try {
      const call = mode === 'rescan' ? rescanArrItem : refreshArrItem;
      await call(inst, t.source as ArrSource, t.arrId!);
      done++;
    } catch (e) {
      failures.push(t.title);
      logEvent(
        'warn',
        source,
        `Could not ${mode} "${t.title}" in ${inst.name || inst.url}: ${String(e)}`
      );
    }
  }

  const verb = mode === 'rescan' ? 'rescan' : 'metadata refresh';
  const parts = [
    done
      ? `Queued a ${verb} for ${done} title${done === 1 ? '' : 's'} in Sonarr/Radarr.`
      : `Nothing was queued.`,
  ];
  if (notInArr) {
    parts.push(`${notInArr} skipped — not matched to a Sonarr/Radarr title.`);
  }
  if (failures.length) {
    parts.push(`${failures.length} failed: ${failures.slice(0, 3).join(', ')}${
      failures.length > 3 ? '…' : ''
    } (see Settings → Logs).`);
  }
  if (done) {
    parts.push('Sizes update once the *arr finishes and the next arr sync runs.');
    logEvent('info', source, `Queued a ${verb} for ${done} title(s) in Sonarr/Radarr.`);
  }
  // The commands are asynchronous in the *arr, so nothing has changed HERE yet:
  // report 0 changed rows so the caller doesn't refetch and show identical
  // numbers, which reads as "the button did nothing".
  return { ok: failures.length === 0, message: parts.join(' '), changed: 0 };
}

/** Rescan/refresh the *arr records behind media items (by rating key). */
export async function arrScanMediaItems(
  ratingKeys: string[],
  mode: 'rescan' | 'refresh'
): Promise<SourceActionResult> {
  const found = arrActionTargets(ratingKeys);
  // Items with no arr_items row never come back from the lookup — count them as
  // skipped rather than losing them silently.
  const targets: ArrTarget[] = found.map((t) => ({
    title: t.title,
    source: t.source,
    instanceId: t.instanceId,
    arrId: t.arrId,
  }));
  const missing = ratingKeys.length - found.length;
  const res = await runArrCommands(targets, mode, 'problems');
  return missing > 0
    ? {
        ...res,
        message: `${res.message} ${missing} skipped — not matched to a Sonarr/Radarr title.`,
      }
    : res;
}

/** Rescan/refresh unmatched *arr titles (the "in *arr, not in <server>" rows). */
export async function arrScanUnmatched(
  keys: string[],
  mode: 'rescan' | 'refresh'
): Promise<SourceActionResult> {
  const wanted = new Set(keys);
  const rows = getArrUnmatched(false).filter((r) => wanted.has(unmatchedKey(r)));
  const targets: ArrTarget[] = rows.map((r) => ({
    title: r.title,
    source: r.source,
    instanceId: r.instanceId,
    arrId: r.arrId,
  }));
  return runArrCommands(targets, mode, 'problems');
}

/**
 * Remove *arr records whose folder the disk scan could not find.
 *
 * The gate is re-read from the database (`on_disk === false`), not trusted from
 * the caller: this is the only action in the fork's Problems surface that
 * removes anything, and "the folder is really gone" is the entire justification
 * for it. Rows that were never verified (`on_disk === null`) are refused too —
 * unknown is not the same as absent.
 */
export async function removeStaleArrRecords(
  keys: string[]
): Promise<SourceActionResult> {
  const wanted = new Set(keys);
  const all = getArrUnmatched(false).filter((r) => wanted.has(unmatchedKey(r)));
  const eligible = all.filter((r) => r.onDisk === false && r.arrId != null);
  const refused = all.length - eligible.length;

  let removed = 0;
  const failures: string[] = [];
  for (const r of eligible) {
    const inst = instanceFor(r.source, r.instanceId);
    if (!inst) {
      failures.push(`${r.title} (its instance is no longer configured)`);
      continue;
    }
    try {
      await removeArrRecord(inst, r.source as ArrSource, r.arrId!);
      deleteArrUnmatchedRow(r.instanceId, r.extKind, r.extId);
      removed++;
      logEvent(
        'info',
        'problems',
        `Removed the ${r.source} record for "${r.title}" (${inst.name || inst.url}) — ` +
          `its folder ${r.path ?? r.folderName ?? ''} isn't on disk. No files were deleted.`
      );
    } catch (e) {
      failures.push(r.title);
      logEvent(
        'warn',
        'problems',
        `Could not remove the ${r.source} record for "${r.title}": ${String(e)}`
      );
    }
  }

  const parts = [
    removed
      ? `Removed ${removed} stale *arr record${removed === 1 ? '' : 's'}. No files were deleted.`
      : 'No records were removed.',
  ];
  if (refused) {
    parts.push(
      `${refused} skipped — the disk scan hasn't confirmed those folders are missing.`
    );
  }
  if (failures.length) {
    parts.push(`${failures.length} failed (see Settings → Logs).`);
  }
  return { ok: failures.length === 0, message: parts.join(' '), changed: removed };
}

/**
 * Re-read (or fully re-identify) items on the media server.
 *
 * `reidentify` is the fix for the identity problems — an item with no provider
 * ids, or ids pointing at the wrong title, can never match Sonarr/Radarr, and
 * no amount of Keeparr-side bookkeeping changes that. Jellyfin/Emby only: Plex
 * has no equivalent single call here, the same limit `triggerServerRefresh`
 * already carries.
 */
export async function refreshServerItems(
  ratingKeys: string[],
  opts: { reidentify?: boolean } = {}
): Promise<SourceActionResult> {
  if (getMediaServerType() === 'plex') {
    return {
      ok: false,
      message: 'Per-item refresh is a Jellyfin/Emby feature — Plex rescans on its own schedule.',
      changed: 0,
    };
  }
  const baseUrl = getServerBaseUrl();
  const token = getAdminToken() || getServerToken();
  if (!baseUrl || !token) {
    return { ok: false, message: 'The media server isn’t connected.', changed: 0 };
  }

  let done = 0;
  const failures: string[] = [];
  for (const id of ratingKeys) {
    try {
      await refreshItem(baseUrl, token, id, { reidentify: opts.reidentify });
      done++;
    } catch (e) {
      failures.push(id);
      logEvent('warn', 'problems', `Could not refresh item ${id} on the media server: ${String(e)}`);
    }
  }

  const what = opts.reidentify ? 're-identify' : 'rescan';
  const parts = [
    done
      ? `Asked the server to ${what} ${done} item${done === 1 ? '' : 's'}.`
      : 'Nothing was sent to the server.',
  ];
  if (opts.reidentify && done) {
    parts.push('New ids appear in Keeparr after the next library sync.');
  }
  if (failures.length) parts.push(`${failures.length} failed (see Settings → Logs).`);
  if (done) {
    logEvent('info', 'problems', `Requested a ${what} of ${done} item(s) on the media server.`);
  }
  // Asynchronous server-side, like the *arr commands — nothing to refetch yet.
  return { ok: failures.length === 0, message: parts.join(' '), changed: 0 };
}

/** Where a row can be opened in the app that owns it. */
export interface SourceLinks {
  /** The title in Sonarr/Radarr. */
  arr?: { url: string; label: string };
  /** The item on the media server. */
  server?: { url: string; label: string };
}

/** `<instance>/series/<slug>` / `<instance>/movie/<slug>` — the *arr's own UI
 *  routes by slug. Null when the title has no slug cached yet (pre-upgrade
 *  rows, until the next arr sync). */
function arrLink(
  source: string,
  instanceId: string,
  titleSlug: string | null
): SourceLinks['arr'] {
  if (!titleSlug) return undefined;
  const inst = instanceFor(source, instanceId);
  if (!inst?.url) return undefined;
  const base = inst.url.replace(/\/$/, '');
  return {
    url: `${base}/${source === 'radarr' ? 'movie' : 'series'}/${titleSlug}`,
    label: `Open in ${source === 'radarr' ? 'Radarr' : 'Sonarr'}`,
  };
}

/** The item's page on the media server (Jellyfin/Emby web UI). */
function serverLink(ratingKey: string): SourceLinks['server'] {
  if (getMediaServerType() === 'plex') return undefined;
  const baseUrl = getServerBaseUrl();
  if (!baseUrl) return undefined;
  return {
    url: `${baseUrl.replace(/\/$/, '')}/web/#/details?id=${encodeURIComponent(ratingKey)}`,
    label: 'Open on the server',
  };
}

/**
 * Links for a set of rows, resolved server-side because every URL involved
 * lives in settings (and the *arr URLs are only ever exposed to admins).
 * Keyed the same way the caller asked: rating key, or `instance|kind|id`.
 */
export function sourceLinksFor(sel: {
  ratingKeys?: string[];
  unmatchedKeys?: string[];
}): Record<string, SourceLinks> {
  const out: Record<string, SourceLinks> = {};

  if (sel.ratingKeys?.length) {
    const targets = new Map(
      arrActionTargets(sel.ratingKeys).map((t) => [t.ratingKey, t])
    );
    for (const key of sel.ratingKeys) {
      const t = targets.get(key);
      const links: SourceLinks = {
        arr: t ? arrLink(t.source, t.instanceId, t.titleSlug) : undefined,
        server: serverLink(key),
      };
      if (links.arr || links.server) out[key] = links;
    }
  }

  if (sel.unmatchedKeys?.length) {
    const wanted = new Set(sel.unmatchedKeys);
    for (const r of getArrUnmatched(false)) {
      if (!wanted.has(unmatchedKey(r))) continue;
      const arr = arrLink(r.source, r.instanceId, r.titleSlug);
      // No server link by definition — these are the titles it can't see.
      if (arr) out[unmatchedKey(r)] = { arr };
    }
  }

  return out;
}

/** Re-exported so the route can describe rows without importing queries too. */
export type { ArrUnmatchedRow };
