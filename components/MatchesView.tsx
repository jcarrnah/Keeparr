'use client';

/**
 * FORK: swipe results (2.4). Two tabs:
 * - Movie night: titles ≥2 chosen users saved for later ("You and Sam both
 *   want to watch these"), optional nobody-has-watched filter.
 * - Consensus: per-item verdict rollup (who wants it / keeps it / released
 *   it), sortable — the human input for deciding what to tag for deletion.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { formatGB } from '@/lib/format';
import { useToast } from './Toaster';
import { VERDICT_META } from './verdict-meta';
import type { Verdict } from '@/lib/types';

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
  // FORK (3.3): weighted score + the opinions inferred from a keep / skip /
  // "OK to delete" rather than an actual swipe.
  score: number;
  voters: number;
  keepImplicitNames: string[];
  doneImplicitNames: string[];
  skipImplicitCount: number;
  skipNames: string[];
  skipImplicitNames: string[];
  // FORK: live deletion tag, so the row can be tagged from here.
  scheduledDeleteAfter?: number;
  scheduledDeleteHeld?: boolean;
}

/**
 * FORK: one row's votes, expanded — every voter with what they actually said,
 * worst-first so it reads in the same direction as the score. The table cells
 * comma-join names by verdict, which answers "who wants this gone" but not
 * "what did Sam say about it"; this does.
 *
 * `implied` marks an opinion inferred from a keep / "don't care" / "OK to
 * delete" rather than a swipe — the distinction has to survive all the way to
 * the screen, or an inference starts reading as a statement.
 */
function voteDetail(r: ConsensusItem): { name: string; verdict: Verdict; implied?: string }[] {
  const out: { name: string; verdict: Verdict; implied?: string }[] = [];
  const add = (names: string[], verdict: Verdict, implied?: string) => {
    for (const name of names) out.push({ name, verdict, implied });
  };
  add(r.neverNames, 'not_interested');
  add(r.doneNames, 'done_with_it');
  add(r.doneImplicitNames, 'done_with_it', 'marked OK to delete');
  add(r.skipNames, 'dont_care');
  add(r.skipImplicitNames, 'dont_care', 'said “don’t care”');
  add(r.wantNames, 'want_to_watch');
  add(r.keepNames, 'loved_it');
  add(r.keepImplicitNames, 'loved_it', 'kept it');
  return out;
}

/** FORK (3.3): the five verdicts as the filter offers them, worst-first so the
 *  list reads the same direction as the score. */
const VERDICT_FILTERS: [string, string][] = [
  ['not_interested', 'Let it go'],
  ['done_with_it', "Wouldn't be mad"],
  ['dont_care', 'Skip'],
  ['want_to_watch', 'Save for later'],
  ['loved_it', 'Worth keeping'],
];

/** "You and Sam", "You, Sam and Alex", "Sam and Alex" … */
function wanterSentence(names: string[], ids: string[], me: string): string {
  const display = ids.map((id, i) => (id === me ? 'You' : names[i]));
  // "You" first reads more naturally.
  display.sort((a, b) => (a === 'You' ? -1 : b === 'You' ? 1 : 0));
  if (display.length <= 1) return display[0] ?? '';
  return `${display.slice(0, -1).join(', ')} and ${display[display.length - 1]}`;
}

export default function MatchesView({
  canTagDeletion = false,
}: {
  /** FORK: admin + deletion enabled → tag straight from a consensus row. */
  canTagDeletion?: boolean;
}) {
  const [tab, setTab] = useState<'night' | 'consensus'>('night');

  // Live-room entry (create / join by code).
  const router = useRouter();
  const [joinCode, setJoinCode] = useState('');
  const [creating, setCreating] = useState(false);

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
  const [sort, setSort] = useState<'votes' | 'size' | 'score'>('votes');
  // FORK (3.3): slice by who said what. Voters come from the same endpoint, so
  // the list includes people who only ever kept things in Browse.
  const [consVoters, setConsVoters] = useState<Participant[]>([]);
  const [voter, setVoter] = useState('');
  const [verdictFilter, setVerdictFilter] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingCons, setLoadingCons] = useState(true);
  // FORK: which row is expanded to show who said what (one at a time — this is
  // a scanning surface, and several open panels stop being scannable).
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [tagBusy, setTagBusy] = useState<string | null>(null);

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
      const params = new URLSearchParams({ sort, offset: String(offset) });
      if (voter) params.set('voter', voter);
      if (verdictFilter) params.set('verdict', verdictFilter);
      try {
        const d = await fetch(`/api/swipe/consensus?${params}`).then((r) => r.json());
        if (s !== seq.current) return;
        setRows((cur) => (append ? [...cur, ...(d.items ?? [])] : d.items ?? []));
        setConsVoters(d.voters ?? []);
        if (d.me) setMe(d.me);
        setHasMore(!!d.hasMore);
        setNextOffset(d.nextOffset ?? 0);
      } catch {
        if (s === seq.current) toast("Couldn't load the consensus list.", 'error');
      } finally {
        if (s === seq.current) setLoadingCons(false);
      }
    },
    [sort, voter, verdictFilter, toast]
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

  /**
   * FORK: schedule (or cancel) a deletion straight from the row you just read
   * the votes on — the whole point of the screen is deciding, and it used to
   * mean memorising a title and going to find it in Browse.
   */
  async function toggleTag(r: ConsensusItem) {
    const tagged = r.scheduledDeleteAfter != null;
    setTagBusy(r.ratingKey);
    try {
      const res = await fetch('/api/admin/scheduled-deletions', {
        method: tagged ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ratingKey: r.ratingKey }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const d = tagged ? null : await res.json();
      setRows((cur) =>
        cur.map((x) =>
          x.ratingKey === r.ratingKey
            ? {
                ...x,
                scheduledDeleteAfter: tagged ? undefined : d.deleteAfter,
                // The server tags a kept item as 'held' rather than refusing —
                // mirror that here so the badge doesn't claim a live countdown.
                scheduledDeleteHeld: tagged ? undefined : r.kept || undefined,
              }
            : x
        )
      );
      // A keep pauses a tag rather than refusing it, so say which happened.
      if (!tagged) {
        toast(
          r.kept
            ? 'Tagged — but paused: someone keeps it. It resumes if the keeps go.'
            : `Scheduled for deletion after ${new Date(d.deleteAfter * 1000).toLocaleDateString()}.`,
          r.kept ? 'info' : 'success'
        );
      } else {
        toast('Deletion cancelled.', 'success');
      }
    } catch {
      toast("Couldn't update the deletion tag.", 'error');
    } finally {
      setTagBusy(null);
    }
  }

  const names = (list: string[]) => list.join(', ');
  /** FORK (3.3): explicit swipers first, then the people whose opinion was
   *  inferred — marked, so "Bob kept it" never reads as "Bob swiped it". */
  const namesWithImplied = (explicit: string[], implied: string[], why: string) =>
    [...explicit, ...implied.map((n) => `${n} (${why})`)].join(', ');

  async function createRoom() {
    setCreating(true);
    try {
      const res = await fetch('/api/swipe/rooms', { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      const { code } = await res.json();
      router.push(`/swipe/rooms/${code}`);
    } catch {
      toast("Couldn't start a room — try again.", 'error');
      setCreating(false);
    }
  }

  function joinByCode() {
    const code = joinCode.trim().toUpperCase();
    if (code.length >= 4) router.push(`/swipe/rooms/${code}`);
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-bold">Matches</h1>
        <Link href="/swipe" className="text-sm text-slate-400 underline hover:text-white">
          ← Back to swiping
        </Link>
      </div>

      {/* FORK: live "movie night" rooms — swipe together in real time. */}
      <div className="mt-4 rounded-xl border border-slate-800 bg-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-200">🍿 Movie night — live room</h2>
            <p className="text-xs text-slate-500">
              Everyone swipes together and lands on the first thing you all want to watch.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={createRoom}
              disabled={creating}
              className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-ink hover:bg-brand-light disabled:opacity-50"
            >
              {creating ? 'Starting…' : 'Start a room'}
            </button>
            <form
              onSubmit={(e) => { e.preventDefault(); joinByCode(); }}
              className="flex items-center gap-1"
            >
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase().slice(0, 6))}
                placeholder="CODE"
                aria-label="Room code"
                className="w-24 rounded-lg border border-slate-700 bg-app px-2 py-1.5 text-center font-mono text-sm uppercase tracking-widest text-slate-100 placeholder:text-slate-600"
              />
              <button
                type="submit"
                disabled={joinCode.length < 4}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-40"
              >
                Join
              </button>
            </form>
          </div>
        </div>
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
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <span className="text-slate-500">Sort:</span>
            <select
              className="rounded-md bg-slate-800 border border-slate-700 px-2 py-1 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value as 'votes' | 'size' | 'score')}
            >
              <option value="score">Most wanted gone (score)</option>
              <option value="votes">Most delete votes</option>
              <option value="size">Largest</option>
            </select>
            {/* FORK (3.3): "show me everything Alice marked 'let it go'".
                Identity is deliberately visible on this screen. */}
            <span className="text-slate-500">Filter:</span>
            <select
              aria-label="Voter"
              className="rounded-md bg-slate-800 border border-slate-700 px-2 py-1 text-sm"
              value={voter}
              onChange={(e) => setVoter(e.target.value)}
            >
              <option value="">Anyone</option>
              {consVoters.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id === me ? 'You' : u.username}
                </option>
              ))}
            </select>
            <select
              aria-label="Verdict"
              className="rounded-md bg-slate-800 border border-slate-700 px-2 py-1 text-sm"
              value={verdictFilter}
              onChange={(e) => setVerdictFilter(e.target.value)}
            >
              <option value="">Any verdict</option>
              {VERDICT_FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {(voter || verdictFilter) && (
              <button
                onClick={() => {
                  setVoter('');
                  setVerdictFilter('');
                }}
                className="text-xs text-slate-400 underline hover:text-white"
              >
                Clear
              </button>
            )}
          </div>

          {loadingCons && rows.length === 0 ? (
            <p className="pt-10 text-center text-slate-500">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="pt-10 text-center text-slate-400">
              {voter || verdictFilter
                ? 'Nobody matched that filter.'
                : 'Nothing here yet — the rollup fills in as people swipe or keep things.'}
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr className="border-b border-slate-800">
                    <th className="px-3 py-2">Title</th>
                    <th className="px-3 py-2 text-right">
                      <button
                        onClick={() => setSort('size')}
                        className={sort === 'size' ? 'text-slate-200' : 'hover:text-slate-300'}
                      >
                        Size
                      </button>
                    </th>
                    <th className="px-3 py-2">Save for later</th>
                    <th className="px-3 py-2">Worth keeping</th>
                    <th className="px-3 py-2">Can go / let go</th>
                    <th className="px-3 py-2 text-center">
                      <button
                        onClick={() => setSort('votes')}
                        className={sort === 'votes' ? 'text-slate-200' : 'hover:text-slate-300'}
                      >
                        Delete votes
                      </button>
                    </th>
                    <th className="px-3 py-2 text-center">
                      <button
                        onClick={() => setSort('score')}
                        title="Summed across everyone: let it go +2, wouldn't be mad +1, skip 0, save for later −1, worth keeping −2. Higher = the household wants it gone."
                        className={sort === 'score' ? 'text-slate-200' : 'hover:text-slate-300'}
                      >
                        Score
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Fragment key={r.ratingKey}>
                    <tr
                      className="cursor-pointer border-b border-slate-800/60 hover:bg-slate-900/60"
                      onClick={() => setOpenRow((cur) => (cur === r.ratingKey ? null : r.ratingKey))}
                      title="Show who said what"
                    >
                      <td className="px-3 py-2">
                        <span className="mr-1.5 inline-block w-3 text-slate-500">
                          {openRow === r.ratingKey ? '▾' : '▸'}
                        </span>
                        <span className="font-medium text-slate-200">{r.title}</span>
                        {r.year && <span className="ml-1.5 text-xs text-slate-500">{r.year}</span>}
                        {r.kept && (
                          <span className="ml-2 rounded-full bg-amber-900/80 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
                            Kept
                          </span>
                        )}
                        {r.scheduledDeleteAfter != null && (
                          <span
                            className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                              r.scheduledDeleteHeld
                                ? 'bg-slate-700 text-slate-200'
                                : 'bg-red-500/90 text-paper'
                            }`}
                          >
                            {r.scheduledDeleteHeld
                              ? '⏸ Paused'
                              : `⌛ ${new Date(r.scheduledDeleteAfter * 1000).toLocaleDateString()}`}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400">
                        {formatGB(r.sizeBytes)}
                      </td>
                      <td className="px-3 py-2 text-emerald-300">{names(r.wantNames)}</td>
                      <td className="px-3 py-2 text-sky-300">
                        {namesWithImplied(r.keepNames, r.keepImplicitNames, 'kept')}
                      </td>
                      <td className="px-3 py-2 text-rose-300">
                        {namesWithImplied(
                          [...r.doneNames, ...r.neverNames],
                          r.doneImplicitNames,
                          'OK to delete'
                        )}
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
                      {/* FORK (3.3): signed score — positive means the household
                          wants it gone. Greyed while someone still keeps it, to
                          match how the delete-vote column reads. */}
                      <td className="px-3 py-2 text-center">
                        <span
                          className={`font-mono font-semibold ${
                            r.kept
                              ? 'text-slate-500'
                              : r.score > 0
                                ? 'text-rose-400'
                                : r.score < 0
                                  ? 'text-emerald-400'
                                  : 'text-slate-400'
                          }`}
                          title={`${r.voters} ${r.voters === 1 ? 'person has' : 'people have'} an opinion${
                            r.kept ? '; someone keeps it, so it stays protected' : ''
                          }`}
                        >
                          {r.score > 0 ? `+${r.score}` : r.score}
                        </span>
                      </td>
                    </tr>
                    {/* FORK: who said what, plus the action the whole screen is
                        building towards — decide here, don't go hunting for the
                        title in Browse. */}
                    {openRow === r.ratingKey && (
                      <tr className="border-b border-slate-800/60 bg-slate-900/40">
                        <td colSpan={7} className="px-3 py-3">
                          <div className="flex flex-wrap items-start justify-between gap-4">
                            <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
                              {voteDetail(r).map((v, i) => (
                                <li key={`${v.name}-${i}`} className="flex items-center gap-1.5">
                                  <span className={VERDICT_META[v.verdict].color.split(' ')[0]}>
                                    {VERDICT_META[v.verdict].icon}
                                  </span>
                                  <span className="text-slate-200">{v.name}</span>
                                  <span className="text-slate-500">
                                    {VERDICT_META[v.verdict].short}
                                    {v.implied && ` — ${v.implied}`}
                                  </span>
                                </li>
                              ))}
                            </ul>
                            {canTagDeletion && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void toggleTag(r);
                                }}
                                disabled={tagBusy === r.ratingKey}
                                className={`shrink-0 rounded-md px-3 py-1.5 text-xs disabled:opacity-60 ${
                                  r.scheduledDeleteAfter != null
                                    ? 'border border-slate-600 text-slate-300 hover:border-slate-400'
                                    : 'border border-rose-900/70 text-rose-300 hover:border-rose-700'
                                }`}
                                title={
                                  r.kept && r.scheduledDeleteAfter == null
                                    ? 'Someone keeps this — it will be tagged but paused until the keeps go'
                                    : undefined
                                }
                              >
                                {r.scheduledDeleteAfter != null
                                  ? 'Cancel deletion'
                                  : 'Schedule deletion'}
                              </button>
                            )}
                          </div>
                          {voteDetail(r).length === 0 && (
                            <p className="text-xs text-slate-500">No individual votes recorded.</p>
                          )}
                        </td>
                      </tr>
                    )}
                    </Fragment>
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
