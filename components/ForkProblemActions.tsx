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
 * actually fix. Three groups, in the order you'd reach for them:
 *
 *  1. the one-click Keeparr-side fix for the category (re-link / rescan / disk
 *     scan),
 *  2. **Fix at the source…** — pick rows and act on them in Sonarr/Radarr or on
 *     the media server, which is where most of these problems actually live,
 *  3. **Schedule deletion…** — for the categories where the answer is "this
 *     shouldn't be here at all".
 *
 * No media is deleted from here and the filesystem is never touched. The one
 * removal offered is a *arr RECORD whose folder the disk scan couldn't find
 * (`deleteFiles=false`), and the server re-checks that gate itself.
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

// --- Fix at the source (Sonarr/Radarr + the media server) -------------------

/** One row, as the source picker sees it. A row can have BOTH sides: an
 *  identity mismatch is one media item disagreeing with one *arr record, and
 *  the two fixes act on different ends of it. */
interface SourceCandidate {
  /** Selection id (unique within the category). */
  key: string;
  title: string;
  detail?: string;
  /** Media-server side (rating key), when the row has one. */
  ratingKey?: string;
  /** *arr side, as `instanceId|extKind|extId`, when the row has one. */
  unmatchedKey?: string;
  /** The disk scan confirmed this *arr record's folder is missing. */
  staleRemovable?: boolean;
}

type SourceAction =
  | 'arr-rescan'
  | 'arr-refresh'
  | 'server-rescan'
  | 'server-reidentify'
  | 'arr-remove-stale';

interface SourceFix {
  action: SourceAction;
  label: string;
  hint: string;
  /** Which end of the row it acts on — also what it needs to be enabled. */
  side: 'arr' | 'server';
  /** Only ever offered for rows whose folder is confirmed missing. */
  staleOnly?: boolean;
  /** Renders as a warning: it removes something. */
  destructive?: boolean;
}

const ARR_RESCAN: SourceFix = {
  action: 'arr-rescan',
  label: 'Rescan files in Sonarr/Radarr',
  side: 'arr',
  hint:
    "Makes the *arr look at the title's folder again and re-report its size. " +
    'This is the fix when the *arr is the stale side of a disagreement.',
};
const ARR_REFRESH: SourceFix = {
  action: 'arr-refresh',
  label: 'Refresh metadata in Sonarr/Radarr',
  side: 'arr',
  hint: "Re-pulls the title's metadata in the *arr — the *arr-side half of an identity fix.",
};
const SERVER_RESCAN: SourceFix = {
  action: 'server-rescan',
  label: 'Rescan items on the server',
  side: 'server',
  hint:
    'Asks Jellyfin/Emby to re-read just these items rather than the whole library — ' +
    'it notices files that arrived, changed or vanished.',
};
const SERVER_REIDENTIFY: SourceFix = {
  action: 'server-reidentify',
  label: 'Re-identify on the server',
  side: 'server',
  hint:
    'Full metadata refresh that REPLACES what the server stored, so it can pick up ' +
    'the provider ids (tmdb/tvdb) that Sonarr/Radarr matching runs on. Artwork is ' +
    'kept. New ids show up here after the next library sync.',
};
const ARR_REMOVE_STALE: SourceFix = {
  action: 'arr-remove-stale',
  label: 'Remove the stale *arr record',
  side: 'arr',
  staleOnly: true,
  destructive: true,
  hint:
    "The *arr is tracking a folder the disk scan couldn't find. Removing the record " +
    'deletes no files — there are none — and adds no import exclusion, so the title ' +
    'can come back if it downloads again.',
};

/** Which source fixes each category gets. Categories whose real fix is a human
 *  decision (arrConflicts: remove it from one of two instances) or the
 *  filesystem (diskOrphans) are deliberately absent. */
const SOURCE_FIXES: Partial<Record<ProblemType, SourceFix[]>> = {
  sizeMismatch: [ARR_RESCAN, SERVER_RESCAN],
  zeroSize: [ARR_RESCAN, SERVER_RESCAN],
  missingFromPlex: [ARR_RESCAN, ARR_REMOVE_STALE],
  notInArr: [SERVER_REIDENTIFY],
  missingIds: [SERVER_REIDENTIFY],
  identityMismatch: [SERVER_REIDENTIFY, ARR_REFRESH],
  duplicates: [SERVER_RESCAN],
};

/** Pull `SourceCandidate`s out of each category's differently-shaped rows. */
const SOURCE_CANDIDATES: Partial<Record<ProblemType, (items: unknown[]) => SourceCandidate[]>> = {
  sizeMismatch: (items) =>
    (items as { ratingKey: string; title: string; arrBytes?: number | null; sizeBytes: number }[]).map(
      (r) => ({
        key: r.ratingKey,
        ratingKey: r.ratingKey,
        title: r.title,
        detail:
          r.arrBytes != null
            ? `server ${formatSize(r.sizeBytes)} · *arr ${formatSize(r.arrBytes)}`
            : undefined,
      })
    ),
  zeroSize: (items) =>
    (items as { ratingKey: string; title: string; arrBytes: number | null }[]).map((r) => ({
      key: r.ratingKey,
      ratingKey: r.ratingKey,
      title: r.title,
      detail: r.arrBytes ? `*arr still has ${formatSize(r.arrBytes)}` : 'no files on either side',
    })),
  notInArr: (items) =>
    (items as { ratingKey: string; title: string }[]).map((r) => ({
      key: r.ratingKey,
      ratingKey: r.ratingKey,
      title: r.title,
    })),
  missingIds: (items) =>
    (items as { ratingKey: string; title: string }[]).map((r) => ({
      key: r.ratingKey,
      ratingKey: r.ratingKey,
      title: r.title,
    })),
  missingFromPlex: (items) =>
    (
      items as {
        instanceId: string;
        extKind: string;
        extId: string;
        title: string;
        instanceName: string;
        onDisk: boolean | null;
        path: string | null;
      }[]
    ).map((r) => ({
      key: `${r.instanceId}|${r.extKind}|${r.extId}`,
      unmatchedKey: `${r.instanceId}|${r.extKind}|${r.extId}`,
      title: r.title,
      staleRemovable: r.onDisk === false,
      detail:
        r.onDisk === false
          ? `${r.instanceName} · not on disk`
          : r.onDisk === true
            ? `${r.instanceName} · on disk`
            : `${r.instanceName} · not checked`,
    })),
  identityMismatch: (items) =>
    (
      items as {
        media: { ratingKey: string; title: string };
        arr: { title: string; instanceId: string; extKind: string; extId: string };
      }[]
    ).map((r) => ({
      key: r.media.ratingKey,
      ratingKey: r.media.ratingKey,
      unmatchedKey: `${r.arr.instanceId}|${r.arr.extKind}|${r.arr.extId}`,
      title: r.media.title,
      detail: `*arr calls it "${r.arr.title}"`,
    })),
  duplicates: (items) =>
    (items as { items: { ratingKey: string; title: string; dirPath: string | null }[] }[])
      .flatMap((g) => g.items)
      .map((r) => ({
        key: r.ratingKey,
        ratingKey: r.ratingKey,
        title: r.title,
        detail: r.dirPath ?? undefined,
      })),
};

/** Where one row can be opened in the app that owns it (resolved server-side —
 *  the *arr URLs live in settings and never reach a non-admin). */
interface RowLinks {
  arr?: { url: string; label: string };
  server?: { url: string; label: string };
}

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
  // The same call answers "is there an *arr?" and "which media server?", which
  // decide whether a source fix can work at all.
  const [deletionOn, setDeletionOn] = useState(false);
  const [arrOn, setArrOn] = useState(false);
  const [serverOn, setServerOn] = useState(false);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  // The source picker is a second panel over the same rows.
  const [sourcing, setSourcing] = useState(false);
  const [sourceChosen, setSourceChosen] = useState<Set<string>>(new Set());
  const [links, setLinks] = useState<Record<string, RowLinks>>({});
  const toast = useToast();

  useEffect(() => {
    fetch('/api/admin/settings')
      .then((r) => r.json())
      .then((d) => {
        setDeletionOn(!!d?.deletion?.enabled);
        setArrOn(
          (d?.sonarr?.instances?.length ?? 0) + (d?.radarr?.instances?.length ?? 0) > 0
        );
        // Per-item refresh is a Jellyfin/Emby call; Plex rescans on its own.
        setServerOn(!!d?.mediaServerType && d.mediaServerType !== 'plex');
      })
      .catch(() => {});
  }, []);
  // A stale selection must never survive into another category — the keys would
  // still be valid and you'd tag things you can no longer see.
  useEffect(() => {
    setPicking(false);
    setChosen(new Set());
    setSourcing(false);
    setSourceChosen(new Set());
    setLinks({});
  }, [type]);

  const spec = type ? ACTIONS[type] : undefined;
  const candidates = type && deletionOn ? (CANDIDATES[type]?.(items) ?? []) : [];
  const chosenBytes = candidates
    .filter((c) => chosen.has(c.ratingKey))
    .reduce((a, c) => a + c.sizeBytes, 0);

  // --- Fix at the source ----------------------------------------------------
  const sourceCandidates = type ? (SOURCE_CANDIDATES[type]?.(items) ?? []) : [];
  const sourceFixes = (type ? (SOURCE_FIXES[type] ?? []) : []).filter((f) =>
    f.side === 'arr' ? arrOn : serverOn
  );
  const sourceSelection = sourceCandidates.filter((c) => sourceChosen.has(c.key));
  const staleSelected = sourceSelection.filter((c) => c.staleRemovable).length;

  /** Ask the server where these rows can be opened. One call per panel open —
   *  every URL involved is a setting, so the client never resolves them. */
  const loadLinks = async (rows: SourceCandidate[]) => {
    const params = new URLSearchParams();
    const ratingKeys = rows.map((r) => r.ratingKey).filter(Boolean) as string[];
    const unmatchedKeys = rows.map((r) => r.unmatchedKey).filter(Boolean) as string[];
    if (ratingKeys.length) params.set('ratingKeys', ratingKeys.slice(0, 100).join(','));
    if (unmatchedKeys.length) params.set('unmatchedKeys', unmatchedKeys.slice(0, 100).join(','));
    if (![...params].length) return;
    try {
      const d = await fetch(`/api/admin/problem-actions?${params}`).then((r) => r.json());
      setLinks(d.links ?? {});
    } catch {
      /* links are a convenience — the actions work without them */
    }
  };

  const runSourceFix = async (fix: SourceFix) => {
    // A stale-record removal must only ever carry the rows the disk scan
    // cleared; the server re-checks, but sending the others would make the
    // "N skipped" line in the result confusing rather than informative.
    const rows = fix.staleOnly
      ? sourceSelection.filter((c) => c.staleRemovable)
      : sourceSelection;
    const ratingKeys = fix.side === 'server' ? rows.map((r) => r.ratingKey).filter(Boolean) : [];
    const unmatchedKeys =
      fix.side === 'arr' ? rows.map((r) => r.unmatchedKey).filter(Boolean) : [];
    // An *arr fix on rows that only have a media side acts through their
    // arr_items match, which the server resolves from the rating key.
    const arrByRatingKey =
      fix.side === 'arr' && unmatchedKeys.length === 0
        ? rows.map((r) => r.ratingKey).filter(Boolean)
        : [];

    setBusy(true);
    try {
      const res = await fetch('/api/admin/problem-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: fix.action,
          ratingKeys: [...ratingKeys, ...arrByRatingKey],
          unmatchedKeys,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as { ok?: boolean; message?: string; changed?: number };
      toast(d.message ?? 'Done.', d.ok === false ? 'error' : d.changed ? 'success' : 'info');
      if (d.changed) {
        setSourceChosen(new Set());
        onDone();
      }
    } catch {
      toast("Couldn't run that fix — see Settings → Logs.", 'error');
    } finally {
      setBusy(false);
    }
  };

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

  const hasSourceFixes = sourceFixes.length > 0 && sourceCandidates.length > 0;
  if (!spec && candidates.length === 0 && !hasSourceFixes) return null;

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
        {/* Most of these rows can only really be fixed in the app that owns
            the title, and walking over to that app is where triage stops. */}
        {hasSourceFixes && (
          <button
            onClick={() => {
              setSourcing((s) => {
                if (!s) void loadLinks(sourceCandidates);
                return !s;
              });
            }}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:border-slate-500"
          >
            {sourcing ? 'Close' : 'Fix at the source…'}
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

      {sourcing && (
        <div className="mt-3 border-t border-slate-800 pt-3">
          <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
            <button
              onClick={() =>
                setSourceChosen((cur) =>
                  cur.size === sourceCandidates.length
                    ? new Set()
                    : new Set(sourceCandidates.map((c) => c.key))
                )
              }
              className="text-slate-300 underline hover:text-white"
            >
              {sourceChosen.size === sourceCandidates.length ? 'Select none' : 'Select all'}
            </button>
            <span className="text-slate-500">
              {sourceChosen.size} of {sourceCandidates.length} selected
            </span>
          </div>

          <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {sourceCandidates.map((c) => {
              const l = links[c.ratingKey ?? ''] ?? links[c.unmatchedKey ?? ''] ?? {};
              return (
                <li key={c.key} className="flex items-baseline gap-2 text-xs">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 rounded px-1 py-0.5 hover:bg-slate-800/60">
                    <input
                      type="checkbox"
                      checked={sourceChosen.has(c.key)}
                      onChange={() =>
                        setSourceChosen((cur) => {
                          const next = new Set(cur);
                          if (next.has(c.key)) next.delete(c.key);
                          else next.add(c.key);
                          return next;
                        })
                      }
                    />
                    <span className="truncate text-slate-200">{c.title}</span>
                    {c.detail && (
                      <span className="truncate text-[11px] text-slate-500" title={c.detail}>
                        {c.detail}
                      </span>
                    )}
                    {c.staleRemovable && (
                      <span className="shrink-0 rounded bg-amber-900/50 px-1 text-[10px] text-amber-200">
                        folder missing
                      </span>
                    )}
                  </label>
                  {/* Deep links: the fix that isn't an API call is still one
                      click away instead of a search in another tab. */}
                  {l.arr && (
                    <a
                      href={l.arr.url}
                      target="_blank"
                      rel="noreferrer"
                      title={l.arr.label}
                      className="shrink-0 text-slate-400 underline hover:text-white"
                    >
                      *arr ↗
                    </a>
                  )}
                  {l.server && (
                    <a
                      href={l.server.url}
                      target="_blank"
                      rel="noreferrer"
                      title={l.server.label}
                      className="shrink-0 text-slate-400 underline hover:text-white"
                    >
                      server ↗
                    </a>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="mt-3 flex flex-wrap gap-2">
            {sourceFixes.map((f) => {
              const n = f.staleOnly ? staleSelected : sourceSelection.length;
              return (
                <button
                  key={f.action}
                  onClick={() => void runSourceFix(f)}
                  disabled={busy || n === 0}
                  title={f.hint}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${
                    f.destructive
                      ? 'border border-amber-800/70 text-amber-200 hover:border-amber-600'
                      : 'border border-slate-700 text-slate-200 hover:border-slate-500'
                  }`}
                >
                  {f.label}
                  {n > 0 && ` (${n})`}
                </button>
              );
            })}
          </div>
          {sourceFixes.map((f) => (
            <p key={f.action} className="mt-2 text-[11px] text-slate-500">
              <span className="text-slate-400">{f.label}:</span> {f.hint}
            </p>
          ))}
        </div>
      )}

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
