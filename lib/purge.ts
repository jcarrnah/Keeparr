/**
 * FORK: the scheduled-deletions purge job. Deletes purge-eligible items via
 * their matched Sonarr/Radarr instance (never the filesystem). Guard rails:
 * master toggle default OFF, dry-run default ON, protective keeps always win
 * (eligibility re-checks keeps at purge time), unmatched items are reported but
 * never deleted. Every action lands in the app log; the run summary lands in
 * job_state/job_runs like any other job.
 */
import { deleteArrItem, type ArrSource } from './arr';
import { sendDiscordMessage } from './discord';
import { formatSize } from './format';
import { syncLeavingSoonCollection } from './leaving-soon';
import {
  arrMatchForItem,
  dueDeletions,
  enteringFinalWeek,
  logEvent,
  markWeekNotified,
  refreshDeletionHolds,
  setDeletionResult,
} from './queries';
import {
  getDeletionDryRun,
  getDeletionEnabled,
  getRadarrInstances,
  getSonarrInstances,
  type ArrInstance,
} from './settings';
import type { JobResult } from './sync';

export async function runPurge(): Promise<JobResult> {
  if (!getDeletionEnabled()) {
    return { result: 0, message: 'Scheduled deletion is disabled — nothing to do.' };
  }

  // Reconcile holds first so "keep removed" items resume their countdown and
  // freshly-kept items are parked before eligibility is computed.
  const { held, released } = refreshDeletionHolds();

  // Discord: one heads-up as items enter their final 7 days (rescue window).
  const finalWeek = enteringFinalWeek();
  if (finalWeek.length > 0) {
    const list = finalWeek
      .slice(0, 15)
      .map(
        (i) =>
          `• ${i.title} (${formatSize(i.size_bytes)}) — ${new Date(i.delete_after * 1000).toLocaleDateString()}`
      )
      .join('\n');
    const sent = await sendDiscordMessage(
      `⏳ **Leaving in the next 7 days** — keep them in Keeparr to rescue:\n${list}` +
        (finalWeek.length > 15 ? `\n…and ${finalWeek.length - 15} more` : '')
    );
    // Only mark when actually delivered — a transient webhook failure (or the
    // webhook being configured later) retries on the next nightly run.
    if (sent) markWeekNotified(finalWeek.map((i) => i.rating_key));
  }

  const due = dueDeletions();
  const dryRun = getDeletionDryRun();

  const instances = new Map<string, ArrInstance>();
  for (const i of getSonarrInstances()) instances.set(`sonarr:${i.id}`, i);
  for (const i of getRadarrInstances()) instances.set(`radarr:${i.id}`, i);

  let deleted = 0;
  let failed = 0;
  let unmatched = 0;
  let bytes = 0;

  for (const item of due) {
    const match = arrMatchForItem(item.rating_key);
    const inst = match ? instances.get(`${match.source}:${match.instance_id}`) : undefined;
    if (!match || match.arr_id == null || !inst) {
      // Report-only: no arr match (or its instance is gone from settings) means
      // we can't delete safely. The tag stays pending and is retried next run.
      unmatched++;
      logEvent(
        'warn',
        'job:purge',
        `"${item.title}" is due for deletion but has no Sonarr/Radarr match — left alone (Keeparr never deletes from the filesystem).`
      );
      continue;
    }

    if (dryRun) {
      deleted++;
      bytes += item.size_bytes;
      logEvent(
        'info',
        'job:purge',
        `DRY RUN: would delete "${item.title}" (${formatSize(item.size_bytes)}) via ${match.source} (${inst.name || inst.url}).`
      );
      continue; // tag stays pending — nothing actually happened
    }

    try {
      await deleteArrItem(inst, match.source as ArrSource, match.arr_id);
      setDeletionResult(
        item.rating_key,
        'deleted',
        `deleted via ${match.source} (${inst.name || inst.url})`
      );
      deleted++;
      bytes += item.size_bytes;
      logEvent(
        'info',
        'job:purge',
        `Deleted "${item.title}" (${formatSize(item.size_bytes)}) via ${match.source} (${inst.name || inst.url}).`
      );
    } catch (e) {
      failed++;
      setDeletionResult(item.rating_key, 'failed', String(e));
      logEvent('error', 'job:purge', `Failed to delete "${item.title}": ${String(e)}`);
    }
  }

  const parts: string[] = [
    dryRun
      ? `DRY RUN — would delete ${deleted} item(s) (${formatSize(bytes)})`
      : `Deleted ${deleted} item(s), reclaimed ${formatSize(bytes)}`,
  ];
  if (failed) parts.push(`${failed} failed`);
  if (unmatched) parts.push(`${unmatched} unmatched (left alone)`);
  if (held) parts.push(`${held} newly held by keeps`);
  if (released) parts.push(`${released} resumed after keep removal`);

  // Discord: purge summary (only when something happened or failed; dry-run
  // stays quiet — its results are in the app log).
  if (!dryRun && (deleted > 0 || failed > 0)) {
    const failNote = failed ? `\n⚠️ ${failed} deletion(s) FAILED — see Settings → Logs.` : '';
    await sendDiscordMessage(
      `🧹 **Purge complete** — deleted ${deleted} item(s), reclaimed ${formatSize(bytes)}.${failNote}`
    );
  }

  // Mirror the (post-purge) pending set into the Leaving Soon collection.
  const leavingSoon = await syncLeavingSoonCollection();
  if (leavingSoon) parts.push(leavingSoon);

  return { result: deleted, message: parts.join('; ') + '.' };
}
