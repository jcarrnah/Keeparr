'use client';

/**
 * FORK: swipe results (2.4). Two tabs:
 * - Movie night: titles ≥2 chosen users saved for later ("You and Sam both
 *   want to watch these"), optional nobody-has-watched filter.
 * - Consensus: per-item verdict rollup (who wants it / keeps it / released
 *   it), sortable — the human input for deciding what to tag for deletion.
 */
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatGB } from '@/lib/format';
import { useToast } from './Toaster';

interface MatchItem {
  ratingKey: string;
  title: string;
  year: number | null;
  libraryKind: string;
  sizeBytes: number;
  thumbUrl: string | null;
  imdbRating?: number;
  rtScore?: number;
  wantCount: number;
  wanterIds: string[];
  wanterNames: string[];
}
interface Participant {
  id: string;
  username: string;
}
interface ConsensusItem {
  ratingKey: string;
  title: string;
  year: number | null;
  libraryKind: string;
  sizeBytes: number;
  thumbUrl: string | null;
  kept: boolean;
  wantNames: string[];
  keepNames: string[];
  doneNames: string[];
  neverNames: string[];
  skipCount: number;
  deleteVotes: number;
}

/** "You and Sam", "You, Sam and Alex", "Sam and Alex" … */
function wanterSentence(names: string[], ids: string[], me: string): string {
  const display = ids.map((id, i) => (id === me ? 'You' : names[i]));
  // "You" first reads more naturally.
  display.sort((a, b) => (a === 'You' ? -1 : b === 'You' ? 1 : 0));
  if (display.length <= 1) return display[0] ?? '';
  return `${display.slice(0, -1).join(', ')} and ${display[display.length - 1]}`;
}

export default function MatchesView() {
  const [tab, setTab] = useState<'night' | 'consensus'>('night');

  // Movie night state
  const [matches, setMatches] = useState<MatchItem[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [me, setMe] = useState('');
  // Selected participants; starts as ALL once the list loads (unchecking a
  // person then narrows the match pool as expected).
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [unwatchedOnly, setUnwatchedOnly] = useState(false);
  const [loadingNight, setLoadingNight] = useState(true);

  // Consensus state
  const [rows, setRows] = useState<ConsensusItem[]>([]);
  const [sort, setSort] = useState<'votes' | 'size'>('votes');
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingCons, setLoadingCons] = useState(true);

  const toast = useToast();
  const seq = useRef(0); // stale-response guard (house style)

  const loadMatches = useCallback(async () => {
    const s = ++seq.current;
    setLoadingNight(true);
    const params = new URLSearchParams();
    if (chosen) params.set('users', [...chosen].join(',') || 'none');
    if (unwatchedOnly) params.set('unwatched', '1');
    try {
      const d = await fetch(`/api/swipe/matches?${params}`).then((r) => r.json());
      if (s !== seq.current) return;
      setMatches(d.items ?? []);
      setParticipants(d.users ?? []);
      setMe(d.me ?? '');
      // First load: check everyone.
      setChosen((cur) => cur ?? new Set((d.users ?? []).map((u: Participant) => u.id)));
    } catch {
      if (s === seq.current) toast("Couldn't load matches.", 'error');
    } finally {
      if (s === seq.current) setLoadingNight(false);
    }
  }, [chosen, unwatchedOnly, toast]);

  const loadConsensus = useCallback(
    async (offset: number, append: boolean) => {
      const s = ++seq.current;
      setLoadingCons(true);
      try {
        const d = await fetch(`/api/swipe/consensus?sort=${sort}&offset=${offset}`).then((r) =>
          r.json()
        );
        if (s !== seq.current) return;
        setRows((cur) => (append ? [...cur, ...(d.items ?? [])] : d.items ?? []));
        setHasMore(!!d.hasMore);
        setNextOffset(d.nextOffset ?? 0);
      } catch {
        if (s === seq.current) toast("Couldn't load the consensus list.", 'error');
      } finally {
        if (s === seq.current) setLoadingCons(false);
      }
    },
    [sort, toast]
  );

  useEffect(() => {
    if (tab === 'night') void loadMatches();
  }, [tab, loadMatches]);
  useEffect(() => {
    if (tab === 'consensus') void loadConsensus(0, false);
  }, [tab, loadConsensus]);

  function toggleUser(id: string) {
    setChosen((cur) => {
      const next = new Set(cur ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const names = (list: string[]) => list.join(', ');

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold">Matches</h1>
        <Link href="/swipe" className="text-sm text-slate-400 underline hover:text-white">
          ← Back to swiping
        </Link>
      </div>

      <div className="mt-3 flex items-center gap-1 rounded-lg bg-rail p-1 w-fit">
        {(
          [
            ['night', 'Movie night'],
            ['consensus', 'Consensus'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              tab === value ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'night' ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
            {participants.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-500">Between:</span>
                {participants.map((u) => (
                  <label key={u.id} className="flex items-center gap-1.5 text-slate-300">
                    <input
                      type="checkbox"
                      className="accent-brand"
                      checked={!chosen || chosen.has(u.id)}
                      onChange={() => toggleUser(u.id)}
                    />
                    {u.id === me ? 'You' : u.username}
                  </label>
                ))}
              </div>
            )}
            <label className="flex items-center gap-1.5 text-slate-300">
              <input
                type="checkbox"
                className="accent-brand"
                checked={unwatchedOnly}
                onChange={(e) => setUnwatchedOnly(e.target.checked)}
              />
              Nobody's watched it yet
            </label>
          </div>

          {loadingNight && matches.length === 0 ? (
            <p className="pt-10 text-center text-slate-500">Loading…</p>
          ) : matches.length === 0 ? (
            <p className="pt-10 text-center text-slate-400">
              No overlaps yet — matches appear once two people save the same title for later.
            </p>
          ) : (
            <div className="mt-4 grid gap-3 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
              {matches.map((m) => (
                <div
                  key={m.ratingKey}
                  className="overflow-hidden rounded-lg border border-slate-800 bg-panel"
                >
                  <div className="relative aspect-[2/3] bg-slate-800">
                    {m.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.thumbUrl} alt={m.title} loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center p-2 text-center text-xs text-slate-500">
                        {m.title}
                      </div>
                    )}
                    <div className="absolute right-2 top-2 rounded-full bg-brand px-2 py-0.5 text-xs font-bold text-ink">
                      {m.wantCount}×
                    </div>
                  </div>
                  <div className="p-2">
                    <div className="truncate text-sm font-medium" title={m.title}>
                      {m.title}
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-xs text-slate-400">
                      <span>{m.year ?? ''}</span>
                      <span>
                        {m.imdbRating != null && `⭐ ${m.imdbRating.toFixed(1)}`}
                        {m.rtScore != null && ` 🍅 ${m.rtScore}%`}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-emerald-300">
                      {wanterSentence(m.wanterNames, m.wanterIds, me)} want to watch this
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-3 text-sm">
            <span className="text-slate-500">Sort:</span>
            <select
              className="rounded-md bg-slate-800 border border-slate-700 px-2 py-1 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value as 'votes' | 'size')}
            >
              <option value="votes">Most delete votes</option>
              <option value="size">Largest</option>
            </select>
          </div>

          {loadingCons && rows.length === 0 ? (
            <p className="pt-10 text-center text-slate-500">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="pt-10 text-center text-slate-400">
              Nothing here yet — the rollup fills in as people swipe.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr className="border-b border-slate-800">
                    <th className="px-3 py-2">Title</th>
                    <th className="px-3 py-2 text-right">Size</th>
                    <th className="px-3 py-2">Save for later</th>
                    <th className="px-3 py-2">Worth keeping</th>
                    <th className="px-3 py-2">Can go / let go</th>
                    <th className="px-3 py-2 text-center">Delete votes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.ratingKey} className="border-b border-slate-800/60">
                      <td className="px-3 py-2">
                        <span className="font-medium text-slate-200">{r.title}</span>
                        {r.year && <span className="ml-1.5 text-xs text-slate-500">{r.year}</span>}
                        {r.kept && (
                          <span className="ml-2 rounded-full bg-amber-900/80 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
                            Kept
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400">
                        {formatGB(r.sizeBytes)}
                      </td>
                      <td className="px-3 py-2 text-emerald-300">{names(r.wantNames)}</td>
                      <td className="px-3 py-2 text-sky-300">{names(r.keepNames)}</td>
                      <td className="px-3 py-2 text-rose-300">
                        {names([...r.doneNames, ...r.neverNames])}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {r.deleteVotes > 0 ? (
                          <span
                            className={`font-semibold ${r.kept ? 'text-slate-500' : 'text-rose-400'}`}
                            title={r.kept ? 'Has delete votes but someone keeps it' : undefined}
                          >
                            {r.deleteVotes}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hasMore && (
                <button
                  onClick={() => loadConsensus(nextOffset, true)}
                  disabled={loadingCons}
                  className="mt-3 rounded-md border border-slate-700 px-4 py-2 text-sm hover:border-slate-500 disabled:opacity-60"
                >
                  {loadingCons ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
