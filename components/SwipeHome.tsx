'use client';

/**
 * FORK (3.8): the front door for Swipe.
 *
 * `/swipe` used to drop straight into the card stack, which is the right
 * destination mid-triage and a poor one for the feature the household actually
 * uses most: the list choice was a cramped tab strip above the deck, and movie
 * night — the thing people want on a Friday evening — lived two navigations
 * away on `/swipe/matches`. This page makes the choice before the deck, puts
 * rooms one tap in, and shows what everyone else has been landing on.
 *
 * It stays out of the way of the returning swiper: "go straight to swiping"
 * sticks in localStorage (like the watch-mode preference already does) and
 * sends `/swipe` on to `/swipe/deck`. `?home=1` always shows this page, so the
 * deck's own "change list" link can get back here without bouncing.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatGB } from '@/lib/format';
import { FEED_WATCH_MODES, type FeedWatchMode } from '@/lib/types';
import ScoreBadge from './ScoreBadge';
import { useToast } from './Toaster';
import {
  SWIPE_SECTION_KEY,
  SWIPE_SKIP_LANDING_KEY,
  SWIPE_WATCH_KEY,
  WATCH_LABELS,
  type WatchSelection,
} from './swipe-prefs';

interface Section {
  id: string;
  title: string;
  kind: string;
  itemCount: number;
}
interface NightPick {
  ratingKey: string;
  title: string;
  year: number | null;
  thumbUrl: string | null;
  wantCount: number;
}
interface GonePick {
  ratingKey: string;
  title: string;
  year: number | null;
  sizeBytes: number;
  score: number;
  voters: number;
}

export default function SwipeHome({
  watchAvailable = false,
  skipLandingAllowed = true,
}: {
  watchAvailable?: boolean;
  /** false when the URL carried ?home=1 — the user asked for this page. */
  skipLandingAllowed?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [sections, setSections] = useState<Section[]>([]);
  const [section, setSection] = useState<'all' | string>('all');
  const [watchMode, setWatchMode] = useState<WatchSelection>('all');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [skipLanding, setSkipLanding] = useState(false);
  // Redirecting straight to the deck — render nothing rather than flashing the
  // page at someone who asked never to see it.
  const [bouncing, setBouncing] = useState(false);

  const [joinCode, setJoinCode] = useState('');
  const [creating, setCreating] = useState(false);

  const [nightPicks, setNightPicks] = useState<NightPick[]>([]);
  const [gonePicks, setGonePicks] = useState<GonePick[]>([]);

  const countSeq = useRef(0); // stale-response guard (house style)

  // Restore the persisted choices, and honour "go straight to swiping".
  useEffect(() => {
    try {
      const savedWatch = localStorage.getItem(SWIPE_WATCH_KEY);
      if (savedWatch && FEED_WATCH_MODES.includes(savedWatch as FeedWatchMode)) {
        setWatchMode(savedWatch as WatchSelection);
      }
      const savedSection = localStorage.getItem(SWIPE_SECTION_KEY);
      if (savedSection) setSection(savedSection);
      const skip = localStorage.getItem(SWIPE_SKIP_LANDING_KEY) === '1';
      setSkipLanding(skip);
      if (skip && skipLandingAllowed) {
        setBouncing(true);
        router.replace('/swipe/deck');
      }
    } catch { /* ignore */ }
  }, [router, skipLandingAllowed]);

  useEffect(() => {
    if (bouncing) return;
    void (async () => {
      try {
        const d = await fetch('/api/sections').then((r) => r.json());
        setSections(d.sections ?? []);
      } catch {
        toast("Couldn't load your libraries.", 'error');
      }
    })();
  }, [bouncing, toast]);

  /** How big is the job for the list you're about to start? */
  useEffect(() => {
    if (bouncing) return;
    const seq = ++countSeq.current;
    const params = new URLSearchParams({ limit: '1' });
    if (section !== 'all') params.set('section', section);
    if (watchAvailable && watchMode !== 'all') params.set('watch', watchMode);
    setRemaining(null);
    void fetch(`/api/swipe/deck?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (seq === countSeq.current) setRemaining(d.remaining ?? 0);
      })
      .catch(() => { /* the count is a nicety; the button still works */ });
  }, [bouncing, section, watchMode, watchAvailable]);

  // What the household has been landing on. Both lists are read-only peeks —
  // the real screens are a click away, so failures stay silent.
  useEffect(() => {
    if (bouncing) return;
    void fetch('/api/swipe/matches')
      .then((r) => r.json())
      .then((d) => setNightPicks((d.items ?? []).slice(0, 4)))
      .catch(() => { /* ignore */ });
    void fetch('/api/swipe/consensus?sort=score')
      .then((r) => r.json())
      .then((d) =>
        setGonePicks(
          (d.items ?? [])
            .filter((r: GonePick) => r.score > 0)
            .slice(0, 5)
        )
      )
      .catch(() => { /* ignore */ });
  }, [bouncing]);

  const remember = useCallback((key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch { /* ignore */ }
  }, []);

  function chooseSection(next: string) {
    setSection(next);
    remember(SWIPE_SECTION_KEY, next);
  }
  function chooseWatch(next: WatchSelection) {
    setWatchMode(next);
    remember(SWIPE_WATCH_KEY, next);
  }
  function chooseSkipLanding(next: boolean) {
    setSkipLanding(next);
    remember(SWIPE_SKIP_LANDING_KEY, next ? '1' : '0');
  }

  function startSwiping() {
    const params = new URLSearchParams();
    if (section !== 'all') params.set('section', section);
    if (watchAvailable && watchMode !== 'all') params.set('watch', watchMode);
    const qs = params.toString();
    router.push(`/swipe/deck${qs ? `?${qs}` : ''}`);
  }

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

  if (bouncing) return null;

  const sectionTitle =
    section === 'all'
      ? 'your libraries'
      : (sections.find((s) => s.id === section)?.title ?? 'this library');

  return (
    <div className="h-full overflow-y-auto px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <h1 className="text-2xl font-bold">Swipe</h1>
        <p className="mt-1 text-sm text-slate-500">
          Say what you think of what's on the server — or get everyone in a room and pick
          something to watch.
        </p>

        {/* Start swiping — the list choice happens here, before the deck. */}
        <section className="mt-4 rounded-xl border border-slate-800 bg-panel p-4">
          <h2 className="text-sm font-semibold text-slate-200">Start swiping</h2>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="text-xs text-slate-500" htmlFor="swipe-library">
              Library
            </label>
            <select
              id="swipe-library"
              value={section}
              onChange={(e) => chooseSection(e.target.value)}
              className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-sm"
            >
              <option value="all">All libraries</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>

          {watchAvailable && (
            <div className="mt-3">
              <div className="text-xs text-slate-500">List</div>
              <div className="mt-1 flex flex-wrap items-center gap-1 rounded-lg bg-rail p-1">
                {(Object.keys(WATCH_LABELS) as WatchSelection[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => chooseWatch(m)}
                    className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                      watchMode === m ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {WATCH_LABELS[m]}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={startSwiping}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-ink hover:bg-brand-light"
            >
              Start swiping →
            </button>
            <span className="text-sm text-slate-400">
              {remaining == null ? (
                'Counting…'
              ) : remaining === 0 ? (
                <>Nothing left in {sectionTitle} — try another list.</>
              ) : (
                <>
                  <span className="font-semibold text-slate-200">
                    {remaining.toLocaleString()}
                  </span>{' '}
                  title{remaining === 1 ? '' : 's'} waiting in {sectionTitle}
                </>
              )}
            </span>
          </div>

          <label className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <input
              type="checkbox"
              className="accent-brand"
              checked={skipLanding}
              onChange={(e) => chooseSkipLanding(e.target.checked)}
            />
            Go straight to swiping next time
          </label>
        </section>

        {/* Movie night — one tap, not two navigations deep. */}
        <section className="mt-3 rounded-xl border border-slate-800 bg-panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">🍿 Movie night — live room</h2>
              <p className="text-xs text-slate-500">
                Everyone swipes together and lands on the first thing you all want to watch.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
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
        </section>

        {/* Where the household has been landing. Both panels link into the
            existing results screen rather than reimplementing it. */}
        <section className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-panel p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-200">Everyone wants to watch</h2>
              <Link
                href="/swipe/matches"
                className="text-xs text-brand underline hover:text-brand-light"
              >
                All matches →
              </Link>
            </div>
            {nightPicks.length === 0 ? (
              <p className="mt-3 text-xs text-slate-500">
                No overlaps yet — matches appear once two people save the same title for later.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-4 gap-2">
                {nightPicks.map((m) => (
                  <div key={m.ratingKey} className="min-w-0">
                    <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-slate-800">
                      {m.thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={m.thumbUrl}
                          alt={m.title}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center p-1 text-center text-[10px] text-slate-500">
                          {m.title}
                        </div>
                      )}
                      <div className="absolute right-1 top-1 rounded-full bg-brand px-1.5 text-[10px] font-bold text-ink">
                        {m.wantCount}×
                      </div>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-slate-400" title={m.title}>
                      {m.title}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-800 bg-panel p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-200">Most wanted gone</h2>
              <Link
                href="/swipe/matches"
                className="text-xs text-brand underline hover:text-brand-light"
              >
                Consensus →
              </Link>
            </div>
            {gonePicks.length === 0 ? (
              <p className="mt-3 text-xs text-slate-500">
                Nothing the household has voted off yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {gonePicks.map((r) => (
                  <li key={r.ratingKey} className="flex items-center gap-2 text-sm">
                    <ScoreBadge score={r.score} voters={r.voters} />
                    <span className="min-w-0 flex-1 truncate" title={r.title}>
                      {r.title}
                      {r.year && <span className="text-slate-500"> ({r.year})</span>}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-slate-500">
                      {formatGB(r.sizeBytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
