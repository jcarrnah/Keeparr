'use client';

/**
 * FORK (3.1): the deletion audit trail. The fork runs destructive automation
 * whose only record was a raw JSON endpoint — and after a live purge "did it
 * actually delete?" turned out to be genuinely hard to answer, because `logs`
 * keeps 1000 rows and `job_runs` 100 runs while every job run writes a line
 * (with recentlyAdded every 5 min that's ~3 days of log, ~8 hours of history).
 * Worse, Browse's tag filter only shows live tags, so a SUCCESSFUL purge makes
 * its tags vanish — an empty view reads as "nothing happened" when it means
 * "it completed".
 *
 * `scheduled_deletions` rows are permanent (nothing deletes them). The data was
 * always there; this is the screen that shows it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatRelative, formatSize } from '@/lib/format';
import { useToast } from './Toaster';

type Status = 'pending' | 'held' | 'deleted' | 'failed' | 'cancelled';

interface Row {
  ratingKey: string;
  title: string;
  sizeBytes: number;
  taggedBy: string;
  taggedByName: string | null;
  taggedAt: number;
  deleteAfter: number;
  status: Status;
  statusAt: number | null;
  statusDetail: string | null;
  kept: boolean;
  removed: boolean;
  verifiedAt: number | null;
  residueBytes: number | null;
}

interface Reclaim {
  claimedBytes: number;
  verifiedClaimedBytes: number;
  residueBytes: number;
  verifiedCount: number;
  unverifiedCount: number;
}

/** Display order = the lifecycle, so the strip reads left to right. */
const STATUSES: { value: Status; label: string; help: string; tone: string }[] = [
  {
    value: 'pending',
    label: 'Counting down',
    help: 'Tagged and waiting out the grace period. Keeping it pauses the countdown.',
    tone: 'text-amber-300 border-amber-700/60',
  },
  {
    value: 'held',
    label: 'Paused by a keep',
    help: 'Someone keeps it, so the countdown is frozen. It resumes if every keep is removed.',
    tone: 'text-sky-300 border-sky-500/50',
  },
  {
    value: 'deleted',
    label: 'Deleted',
    help: 'The purge deleted it through Sonarr/Radarr. Never the filesystem directly.',
    tone: 'text-rose-300 border-rose-700/70',
  },
  {
    value: 'failed',
    label: 'Failed',
    help: "The purge tried and couldn't — the reason is in the detail column.",
    tone: 'text-red-400 border-red-500/60',
  },
  {
    value: 'cancelled',
    label: 'Cancelled',
    help: 'A tag someone called off. Kept as a record rather than deleted.',
    tone: 'text-slate-400 border-slate-700',
  },
];

const statusMeta = (s: Status) => STATUSES.find((x) => x.value === s);

export default function DeletionHistoryView() {
  const [rows, setRows] = useState<Row[]>([]);
  const [reclaim, setReclaim] = useState<Reclaim | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const toast = useToast();
  const seq = useRef(0); // stale-response guard (house style)

  const load = useCallback(async () => {
    const s = ++seq.current;
    setLoading(true);
    try {
      const d = await fetch('/api/admin/scheduled-deletions').then((r) => r.json());
      if (s !== seq.current) return;
      setRows(d.items ?? []);
      setReclaim(d.reclaim ?? null);
      setEnabled(d.enabled !== false);
    } catch {
      if (s === seq.current) toast("Couldn't load the deletion history.", 'error');
    } finally {
      if (s === seq.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  const shown = useMemo(
    () => (filter === 'all' ? rows : rows.filter((r) => r.status === filter)),
    [rows, filter]
  );

  const residueRows = useMemo(
    () => rows.filter((r) => r.status === 'deleted' && (r.residueBytes ?? 0) > 0),
    [rows]
  );

  async function cancel(ratingKey: string) {
    setBusyKey(ratingKey);
    try {
      const res = await fetch('/api/admin/scheduled-deletions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ratingKey }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // The row survives as 'cancelled' (audit), so refetch rather than splice.
      await load();
    } catch {
      toast("Couldn't cancel that tag.", 'error');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold">Deletions</h1>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="rounded-md border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:border-slate-500 disabled:opacity-60"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Every tag ever made, and what became of it. This record is permanent —
        the app log and job history are pruned within days, so they can&apos;t
        answer &quot;did it actually delete?&quot;.
      </p>

      {!enabled && (
        <p className="mt-3 rounded-lg border border-amber-700/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-200">
          Deletion is switched off in Settings → General, so nothing here will be
          acted on. Tags stay put and keep counting down for when you turn it on.
        </p>
      )}

      {/* What actually left the disk. *arr reporting success doesn't mean the
          folder is empty, so the purge re-measures — and this is the only place
          the measurement is visible. */}
      {reclaim && reclaim.verifiedCount + reclaim.unverifiedCount > 0 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-800 bg-panel p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">
              Actually reclaimed
            </div>
            <div className="mt-1 text-2xl font-bold text-emerald-400">
              {formatSize(reclaim.verifiedClaimedBytes - reclaim.residueBytes)}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              measured on disk across {reclaim.verifiedCount}{' '}
              {reclaim.verifiedCount === 1 ? 'deletion' : 'deletions'}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-panel p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">
              Left behind
            </div>
            <div
              className={`mt-1 text-2xl font-bold ${
                reclaim.residueBytes > 0 ? 'text-rose-400' : 'text-slate-400'
              }`}
            >
              {formatSize(reclaim.residueBytes)}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {reclaim.residueBytes > 0
                ? 'reported deleted, still on disk'
                : 'nothing reported deleted is still on disk'}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-panel p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">
              Unverified
            </div>
            <div className="mt-1 text-2xl font-bold text-slate-300">
              {reclaim.unverifiedCount}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {reclaim.unverifiedCount > 0
                ? 'deleted, but the disk couldn’t be checked — map the library in Settings'
                : 'every deletion was checked against the disk'}
            </div>
          </div>
        </div>
      )}

      {/* Status pills — counts included so an empty category still tells you
          something. "0 counting down" is a real answer, not a blank screen. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setFilter('all')}
          className={`rounded-full border px-3 py-1 text-sm ${
            filter === 'all'
              ? 'border-slate-500 bg-slate-800 text-white'
              : 'border-slate-700 text-slate-400 hover:text-white'
          }`}
        >
          All <span className="ml-1 text-xs text-slate-500">{rows.length}</span>
        </button>
        {STATUSES.map((s) => (
          <button
            key={s.value}
            onClick={() => setFilter(s.value)}
            title={s.help}
            className={`rounded-full border px-3 py-1 text-sm ${
              filter === s.value ? `${s.tone} bg-slate-800` : `${s.tone} opacity-70 hover:opacity-100`
            }`}
          >
            {s.label} <span className="ml-1 text-xs opacity-70">{counts[s.value] ?? 0}</span>
          </button>
        ))}
      </div>

      {filter !== 'all' && (
        <p className="mt-2 text-xs text-slate-500">{statusMeta(filter)?.help}</p>
      )}

      {loading && rows.length === 0 ? (
        <p className="pt-10 text-center text-slate-500">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="pt-10 text-center text-slate-400">
          {rows.length === 0
            ? 'Nothing has ever been tagged for deletion.'
            : 'Nothing in this state.'}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-rail text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Tagged by</th>
                <th className="px-3 py-2">Tagged</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2 text-right">Size</th>
                <th className="px-3 py-2 text-right">Left behind</th>
                <th className="px-3 py-2">What happened</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const live = r.status === 'pending' || r.status === 'held';
                return (
                  <tr key={r.ratingKey} className="border-t border-slate-800">
                    <td className="px-3 py-2">
                      <span className="font-medium text-slate-200">{r.title}</span>
                      {r.removed && (
                        <span
                          title="No longer in the media server's library"
                          className="ml-2 rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400"
                        >
                          gone from library
                        </span>
                      )}
                      {r.kept && live && (
                        <span
                          title="Someone keeps it — the countdown is paused"
                          className="ml-2 rounded-full bg-amber-900/80 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200"
                        >
                          kept
                        </span>
                      )}
                    </td>
                    <td className={`px-3 py-2 ${statusMeta(r.status)?.tone.split(' ')[0]}`}>
                      {statusMeta(r.status)?.label ?? r.status}
                    </td>
                    <td className="px-3 py-2 text-slate-400">
                      {/* Rule tags are stored as `rule:<id>`, not a user id. */}
                      {r.taggedBy.startsWith('rule:') ? (
                        <span title={`Auto-tagged by ${r.taggedBy}`}>a rule</span>
                      ) : (
                        (r.taggedByName ?? r.taggedBy)
                      )}
                    </td>
                    <td
                      className="px-3 py-2 text-slate-400"
                      title={new Date(r.taggedAt * 1000).toLocaleString()}
                    >
                      {formatRelative(r.taggedAt)}
                    </td>
                    <td
                      className="px-3 py-2 text-slate-400"
                      title={new Date(r.deleteAfter * 1000).toLocaleString()}
                    >
                      {formatRelative(r.deleteAfter)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-400">
                      {formatSize(r.sizeBytes)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {r.status !== 'deleted' ? (
                        <span className="text-slate-600">—</span>
                      ) : r.residueBytes == null ? (
                        <span
                          className="text-slate-500"
                          title="Couldn't check the disk (library unmapped or root unreadable). This is NOT the same as “nothing left”."
                        >
                          not checked
                        </span>
                      ) : r.residueBytes > 0 ? (
                        <span className="text-rose-400">{formatSize(r.residueBytes)}</span>
                      ) : (
                        <span className="text-emerald-400" title="Measured: the folder is empty">
                          gone
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-400">
                      <span title={r.statusAt ? new Date(r.statusAt * 1000).toLocaleString() : undefined}>
                        {r.statusDetail ?? '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {live && (
                        <button
                          onClick={() => void cancel(r.ratingKey)}
                          disabled={busyKey === r.ratingKey}
                          title="Call off this tag. The row stays as a record."
                          className="whitespace-nowrap rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-slate-500 disabled:opacity-60"
                        >
                          {busyKey === r.ratingKey ? '…' : 'Cancel'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* The shortfall, called out on its own — this is the list worth acting
          on, and it's easy to miss inside a long table. */}
      {residueRows.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-slate-200">
            Said reclaimed, didn&apos;t
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Sonarr/Radarr reported these deleted, but bytes are still on disk.
            They&apos;ll resurface in the disk-orphan scan; clearing them by hand
            is the fix.
          </p>
          <ul className="mt-2 divide-y divide-slate-800 rounded-lg border border-slate-800">
            {residueRows
              .slice()
              .sort((a, b) => (b.residueBytes ?? 0) - (a.residueBytes ?? 0))
              .map((r) => (
                <li
                  key={r.ratingKey}
                  className="flex items-center justify-between gap-4 px-3 py-2 text-sm"
                >
                  <span className="truncate text-slate-300">{r.title}</span>
                  <span className="shrink-0 font-mono text-rose-400">
                    {formatSize(r.residueBytes ?? 0)} left
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
