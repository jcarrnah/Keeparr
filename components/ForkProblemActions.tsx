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
import { useEffect, useState } from 'react';
import type { ProblemType } from '@/lib/types';
import { formatSize } from '@/lib/format';
import { useToast } from './Toaster';

type Action = 'relink' | 'rescan' | 'diskscan';

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
  sizeMismatch: {
    action: 'diskscan',
    label: 'Measure on disk now',
    busyLabel: 'Starting disk scan…',
    hint:
      'The measured size settles which side is stale — the table says "Run Disk ' +
      'scan" for exactly that. The job is weekly, so this is the button that ' +
      "doesn't make you wait until Sunday.",
  },
  diskOrphans: {
    action: 'diskscan',
    label: 'Rescan disk now',
    busyLabel: 'Starting disk scan…',
    hint:
      'Re-walks your mapped library paths. Run it after tidying something up on ' +
      'the server, rather than waiting a week to see the list shrink.',
  },
};

/** A row the fork can offer to schedule for deletion. */
interface Candidate {
  ratingKey: string;
  title: string;
  sizeBytes: number;
  /** Which copy this is, when the title alone can't tell them apart. */
  detail?: string;
}

/**
 * Which categories can be tagged, and how to get `{ratingKey, title, size}` out
 * of their differently-shaped rows.
 *
 * Deliberately NOT every category. `missingFromPlex` and `diskOrphans` rows
 * aren't media items at all (no id to tag, and the fork never touches the
 * filesystem); `removedButKept` items are already tombstoned, so tagging them
 * would fail server-side; and for `sizeMismatch`, `identityMismatch` and
 * `arrConflicts` the fix is a rescan or a match correction — offering deletion
 * there would push the wrong resolution.
 */
const CANDIDATES: Partial<Record<ProblemType, (items: unknown[]) => Candidate[]>> = {
  notInArr: (items) =>
    (items as { ratingKey: string; title: string; sizeBytes: number }[]).map((r) => ({
      ratingKey: r.ratingKey,
      title: r.title,
      sizeBytes: r.sizeBytes,
    })),
  missingIds: (items) =>
    (items as { ratingKey: string; title: string; sizeBytes: number }[]).map((r) => ({
      ratingKey: r.ratingKey,
      title: r.title,
      sizeBytes: r.sizeBytes,
    })),
  zeroSize: (items) =>
    // The server sees no bytes, but the *arr often does — and it's the *arr
    // that does the deleting, so that's the size actually at stake.
    (items as { ratingKey: string; title: string; arrBytes: number | null }[]).map((r) => ({
      ratingKey: r.ratingKey,
      title: r.title,
      sizeBytes: r.arrBytes ?? 0,
      detail: r.arrBytes ? 'server sees 0 bytes; *arr still has files' : 'no files on either side',
    })),
  duplicates: (items) =>
    // Groups, not rows: the decision is "which copy goes", so flatten to the
    // individual copies and label each with its folder.
    (items as { items: { ratingKey: string; title: string; sizeBytes: number; dirPath: string | null }[] }[])
      .flatMap((g) => g.items)
      .map((r) => ({
        ratingKey: r.ratingKey,
        title: r.title,
        sizeBytes: r.sizeBytes,
        detail: r.dirPath ?? undefined,
      })),
};

export default function ForkProblemActions({
  type,
  items = [],
  onDone,
}: {
  type: ProblemType | null;
  /** The rows currently on screen — the tag picker acts on exactly these. */
  items?: unknown[];
  /** Refetch the current category once an action has changed something. */
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Read the deletion toggle here rather than threading a prop through
  // upstream's component: keeping ProblemsView at one changed line is the
  // whole point of this file (FORK_SYNC.md). The page is already admin-only.
  const [deletionOn, setDeletionOn] = useState(false);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const toast = useToast();

  useEffect(() => {
    fetch('/api/admin/settings')
      .then((r) => r.json())
      .then((d) => setDeletionOn(!!d?.deletion?.enabled))
      .catch(() => {});
  }, []);
  // A stale selection must never survive into another category — the keys would
  // still be valid and you'd tag things you can no longer see.
  useEffect(() => {
    setPicking(false);
    setChosen(new Set());
  }, [type]);

  const spec = type ? ACTIONS[type] : undefined;
  const candidates = type && deletionOn ? (CANDIDATES[type]?.(items) ?? []) : [];
  const chosenBytes = candidates
    .filter((c) => chosen.has(c.ratingKey))
    .reduce((a, c) => a + c.sizeBytes, 0);

  const tagChosen = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/scheduled-deletions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ratingKeys: [...chosen] }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as { tagged: number; skipped: number; deleteAfter: number };
      toast(
        `Scheduled ${d.tagged} title${d.tagged === 1 ? '' : 's'} for deletion after ` +
          `${new Date(d.deleteAfter * 1000).toLocaleDateString()}` +
          (d.skipped ? ` (${d.skipped} skipped — gone from the server).` : '.'),
        d.tagged ? 'success' : 'info'
      );
      setChosen(new Set());
      setPicking(false);
    } catch {
      toast("Couldn't schedule those deletions — see Settings → Logs.", 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!spec && candidates.length === 0) return null;

  const run = async () => {
    if (!spec) return;
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
    <div className="mb-3 rounded-lg border border-slate-800 bg-panel px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        {spec && (
          <button
            onClick={run}
            disabled={busy}
            className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-ink hover:opacity-90 disabled:opacity-60"
          >
            {busy ? spec.busyLabel : spec.label}
          </button>
        )}
        {/* Deciding a title is junk and acting on it used to be two screens —
            you had to memorise the name and go find it in Browse. */}
        {candidates.length > 0 && (
          <button
            onClick={() => setPicking((p) => !p)}
            className="rounded-md border border-rose-900/70 px-3 py-1.5 text-sm text-rose-300 hover:border-rose-700"
          >
            {picking ? 'Close' : 'Schedule deletion…'}
          </button>
        )}
        {spec && <p className="text-xs text-slate-400 flex-1 min-w-[16rem]">{spec.hint}</p>}
      </div>

      {picking && (
        <div className="mt-3 border-t border-slate-800 pt-3">
          <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
            <button
              onClick={() =>
                setChosen((cur) =>
                  cur.size === candidates.length
                    ? new Set()
                    : new Set(candidates.map((c) => c.ratingKey))
                )
              }
              className="text-slate-300 underline hover:text-white"
            >
              {chosen.size === candidates.length ? 'Select none' : 'Select all'}
            </button>
            <span className="text-slate-500">
              {chosen.size} of {candidates.length} selected
              {chosen.size > 0 && ` · ${formatSize(chosenBytes)}`}
            </span>
            <button
              onClick={() => void tagChosen()}
              disabled={busy || chosen.size === 0}
              className="ml-auto rounded-md bg-rose-700 px-3 py-1.5 font-medium text-paper hover:bg-rose-600 disabled:opacity-50"
            >
              {busy ? 'Scheduling…' : `Schedule ${chosen.size || ''}`}
            </button>
          </div>
          <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {candidates.map((c) => (
              <li key={c.ratingKey}>
                <label className="flex cursor-pointer items-baseline gap-2 rounded px-1 py-0.5 text-xs hover:bg-slate-800/60">
                  <input
                    type="checkbox"
                    checked={chosen.has(c.ratingKey)}
                    onChange={() =>
                      setChosen((cur) => {
                        const next = new Set(cur);
                        if (next.has(c.ratingKey)) next.delete(c.ratingKey);
                        else next.add(c.ratingKey);
                        return next;
                      })
                    }
                  />
                  <span className="text-slate-200">{c.title}</span>
                  <span className="font-mono text-slate-500">{formatSize(c.sizeBytes)}</span>
                  {c.detail && (
                    <span className="truncate font-mono text-[11px] text-slate-600" title={c.detail}>
                      {c.detail}
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-slate-500">
            Tagging is reversible: each gets the configured grace period, anyone keeping
            an item pauses its countdown, and the whole thing is cancellable from
            Deletions.
          </p>
        </div>
      )}
    </div>
  );
}
