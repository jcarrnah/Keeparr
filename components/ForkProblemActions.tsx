'use client';

/**
 * FORK: fix-it actions for the Problems page.
 *
 * Upstream's `ProblemsView` renders each category through a hand-written branch
 * of one big switch (~23 inline action-badge sites) and is actively developed.
 * Hanging fork buttons off those rows would conflict on every upstream sync, in
 * mid-file JSX. So ALL fork UI lives here and upstream's file gets exactly one
 * line — see FORK_SYNC.md.
 *
 * Renders an action bar above the table, only for categories the fork can
 * actually fix. Everything here is non-destructive: no media is deleted and the
 * filesystem is never touched (the fork deletes via Sonarr/Radarr only).
 */
import { useState } from 'react';
import type { ProblemType } from '@/lib/types';
import { useToast } from './Toaster';

type Action = 'relink' | 'rescan';

interface ActionSpec {
  action: Action;
  label: string;
  busyLabel: string;
  /** Why this fixes the category the user is looking at. */
  hint: string;
}

/**
 * Which fix applies to which category.
 *
 * - `removedButKept` is the 4K-upgrade case: the keep is stranded on the old
 *   item id while the live copy sits unprotected. Re-linking moves it across.
 * - `zeroSize` items are usually already-deleted titles the server still lists
 *   because it hasn't rescanned; a refresh makes them disappear.
 */
const ACTIONS: Partial<Record<ProblemType, ActionSpec>> = {
  removedButKept: {
    action: 'relink',
    label: 'Re-link keeps to the new copies',
    busyLabel: 'Re-linking…',
    hint:
      'These keeps point at item ids the server replaced (typically a 4K re-add). ' +
      'Re-linking moves each keep — and its watch history — onto the live copy, ' +
      'which also re-protects it from deletion rules. Runs nightly too.',
  },
  zeroSize: {
    action: 'rescan',
    label: 'Rescan the library',
    busyLabel: 'Starting rescan…',
    hint:
      'Titles the server still lists but whose files are gone. A rescan makes it ' +
      'notice and drop the empty entries.',
  },
  missingFromPlex: {
    action: 'rescan',
    label: 'Rescan the library',
    busyLabel: 'Starting rescan…',
    hint:
      "Sonarr/Radarr has these but the server doesn't. If the files are really " +
      'there, a rescan is what makes the server pick them up.',
  },
};

export default function ForkProblemActions({
  type,
  onDone,
}: {
  type: ProblemType | null;
  /** Refetch the current category once an action has changed something. */
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const spec = type ? ACTIONS[type] : undefined;
  if (!spec) return null;

  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/problem-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: spec.action }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as { message?: string; changed?: number };
      toast(d.message ?? 'Done.', d.changed ? 'success' : 'info');
      // A rescan is asynchronous server-side, so an immediate refetch would
      // still show the old rows — only refetch when something really changed.
      if (d.changed && spec.action !== 'rescan') onDone();
    } catch {
      toast("Couldn't run that fix — see Settings → Logs.", 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-panel px-3 py-2">
      <button
        onClick={run}
        disabled={busy}
        className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-ink hover:opacity-90 disabled:opacity-60"
      >
        {busy ? spec.busyLabel : spec.label}
      </button>
      <p className="text-xs text-slate-400 flex-1 min-w-[16rem]">{spec.hint}</p>
    </div>
  );
}
