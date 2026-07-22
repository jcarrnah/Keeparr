'use client';

/**
 * FORK: swipe mode ("Tinder for the library") — a card stack over the movie
 * library producing per-user verdicts. Gestures: right = want_to_watch,
 * up = loved_it, left = not_interested, down = done_with_it; the Skip button
 * (or S) = dont_care. Buttons + arrow keys cover desktop. Plain pointer
 * events — upstream is dependency-light, so no animation library.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatGB } from '@/lib/format';
import {
  FEED_WATCH_MODES,
  type FeedWatchMode,
  type MediaCardData,
  type Verdict,
} from '@/lib/types';
import { useToast } from './Toaster';

type WatchSelection = 'all' | FeedWatchMode;
const WATCH_LABELS: Record<WatchSelection, string> = {
  all: 'Everything',
  never_played: 'Never played',
  stale_90: 'Not watched in 90d+',
  recent_30: 'Watched recently',
  my_unwatched: 'My unwatched',
};
const WATCH_KEY = 'keeparr.swipeWatchMode';

const SWIPE_THRESHOLD = 90; // px of drag that commits a verdict

interface VerdictDef {
  verdict: Verdict;
  label: string;
  color: string; // overlay + button accent classes
  dir: 'left' | 'right' | 'up' | 'down' | null;
}
const VERDICT_DEFS: VerdictDef[] = [
  { verdict: 'not_interested', label: 'Not interested', color: 'text-rose-400 border-rose-500', dir: 'left' },
  { verdict: 'done_with_it', label: 'Done with it', color: 'text-amber-400 border-amber-500', dir: 'down' },
  { verdict: 'dont_care', label: 'Skip', color: 'text-slate-300 border-slate-500', dir: null },
  { verdict: 'want_to_watch', label: 'Want to watch', color: 'text-emerald-400 border-emerald-500', dir: 'right' },
  { verdict: 'loved_it', label: 'Loved it', color: 'text-sky-400 border-sky-500', dir: 'up' },
];
const byDir = (d: 'left' | 'right' | 'up' | 'down') =>
  VERDICT_DEFS.find((v) => v.dir === d)!;

/** Direction a drag delta commits to, or null inside the threshold. */
function dragVerdict(dx: number, dy: number): VerdictDef | null {
  if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return null;
  return Math.abs(dx) >= Math.abs(dy)
    ? byDir(dx > 0 ? 'right' : 'left')
    : byDir(dy > 0 ? 'down' : 'up');
}

/** Off-screen fling transform for a committed direction. */
function flingTransform(dir: 'left' | 'right' | 'up' | 'down' | null): string {
  switch (dir) {
    case 'left': return 'translate(-120vw, 0) rotate(-20deg)';
    case 'right': return 'translate(120vw, 0) rotate(20deg)';
    case 'up': return 'translate(0, -120vh)';
    case 'down': return 'translate(0, 120vh)';
    default: return 'scale(0.8)'; // skip: shrink away in place
  }
}

interface UndoEntry {
  item: MediaCardData;
  verdict: Verdict;
}

export default function SwipeView({ watchAvailable = false }: { watchAvailable?: boolean }) {
  const [deck, setDeck] = useState<MediaCardData[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [watchMode, setWatchMode] = useState<WatchSelection>('all');
  const [loading, setLoading] = useState(true);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  // Drag state for the top card; leaving = fling animation in progress.
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [leaving, setLeaving] = useState<{ key: string; dir: VerdictDef['dir'] } | null>(null);
  const toast = useToast();
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const feedSeq = useRef(0); // stale-response guard (house style)

  // Restore the persisted list filter.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(WATCH_KEY);
      if (saved && FEED_WATCH_MODES.includes(saved as FeedWatchMode)) {
        setWatchMode(saved as WatchSelection);
      }
    } catch { /* ignore */ }
  }, []);

  const loadDeck = useCallback(
    async (replace: boolean) => {
      const seq = ++feedSeq.current;
      if (replace) setLoading(true);
      const params = new URLSearchParams({ limit: '30' });
      if (watchAvailable && watchMode !== 'all') params.set('watch', watchMode);
      try {
        const d = await fetch(`/api/swipe/deck?${params}`).then((r) => r.json());
        if (seq !== feedSeq.current) return;
        setRemaining(d.remaining ?? null);
        setDeck((cur) => {
          if (replace) return d.items ?? [];
          // Top-up: append only cards not already in the local stack.
          const have = new Set(cur.map((i) => i.ratingKey));
          return [...cur, ...(d.items ?? []).filter((i: MediaCardData) => !have.has(i.ratingKey))];
        });
      } catch {
        if (seq === feedSeq.current) toast("Couldn't load the deck — is the server reachable?", 'error');
      } finally {
        if (seq === feedSeq.current) setLoading(false);
      }
    },
    [watchMode, watchAvailable, toast]
  );

  useEffect(() => {
    loadDeck(true);
  }, [loadDeck]);

  const top = deck[0] ?? null;

  const commit = useCallback(
    (def: VerdictDef) => {
      const item = deck[0];
      if (!item || leaving) return;
      setLeaving({ key: item.ratingKey, dir: def.dir });
      setDrag(null);
      // Let the fling play, then drop the card and record the verdict.
      setTimeout(() => {
        setLeaving(null);
        setDeck((cur) => cur.slice(1));
        setUndoStack((u) => [{ item, verdict: def.verdict }, ...u].slice(0, 5));
        setRemaining((r) => (r == null ? r : Math.max(0, r - 1)));
        void fetch('/api/swipe/verdict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ratingKey: item.ratingKey, verdict: def.verdict }),
        }).then((res) => {
          if (!res.ok) toast(`Couldn't save "${item.title}" — swipe it again later.`, 'error');
        }).catch(() => toast(`Couldn't save "${item.title}" — swipe it again later.`, 'error'));
      }, 220);
    },
    [deck, leaving, toast]
  );

  // Top up the local stack as it runs low.
  useEffect(() => {
    if (!loading && deck.length > 0 && deck.length < 5 && (remaining ?? 0) > deck.length) {
      void loadDeck(false);
    }
  }, [deck.length, loading, remaining, loadDeck]);

  const undo = useCallback(async () => {
    const [last, ...rest] = undoStack;
    if (!last) return;
    setUndoStack(rest);
    setDeck((cur) => [last.item, ...cur]);
    setRemaining((r) => (r == null ? r : r + 1));
    try {
      const res = await fetch('/api/swipe/verdict', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ratingKey: last.item.ratingKey }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      toast("Couldn't undo on the server — the verdict may still stand.", 'error');
    }
  }, [undoStack, toast]);

  // Keyboard: arrows swipe, S skips, U undoes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      const map: Record<string, VerdictDef | undefined> = {
        ArrowLeft: byDir('left'),
        ArrowRight: byDir('right'),
        ArrowUp: byDir('up'),
        ArrowDown: byDir('down'),
        s: VERDICT_DEFS[2],
        S: VERDICT_DEFS[2],
      };
      if (map[e.key]) {
        e.preventDefault();
        commit(map[e.key]!);
      } else if (e.key === 'u' || e.key === 'U') {
        void undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commit, undo]);

  function onPointerDown(e: React.PointerEvent) {
    if (leaving) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragStart.current = { x: e.clientX, y: e.clientY };
    setDrag({ dx: 0, dy: 0 });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragStart.current) return;
    setDrag({ dx: e.clientX - dragStart.current.x, dy: e.clientY - dragStart.current.y });
  }
  function onPointerUp() {
    if (!dragStart.current || !drag) return;
    dragStart.current = null;
    const def = dragVerdict(drag.dx, drag.dy);
    if (def) commit(def);
    else setDrag(null); // spring back
  }

  function chooseWatch(next: WatchSelection) {
    setWatchMode(next);
    try {
      localStorage.setItem(WATCH_KEY, next);
    } catch { /* ignore */ }
  }

  const activeDef = drag ? dragVerdict(drag.dx, drag.dy) : null;

  return (
    <div className="h-full flex flex-col items-center px-6 py-4">
      <div className="w-full max-w-md">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-bold">Swipe</h1>
          {remaining != null && (
            <span className="text-xs text-slate-500">
              {remaining.toLocaleString()} movie{remaining === 1 ? '' : 's'} left
            </span>
          )}
        </div>
        {watchAvailable && (
          <div className="mt-2 flex flex-wrap items-center gap-1 rounded-lg bg-rail p-1">
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
        )}
      </div>

      {/* Card stack */}
      <div className="relative mt-4 w-full max-w-md flex-1 min-h-0 select-none">
        {loading && deck.length === 0 ? (
          <p className="pt-16 text-center text-slate-500">Loading…</p>
        ) : deck.length === 0 ? (
          <div className="pt-16 text-center text-slate-400">
            <p className="text-lg">Deck's empty — you've swiped this list. 🎉</p>
            <p className="mt-2 text-sm text-slate-500">Try another list above, or check back after new arrivals.</p>
          </div>
        ) : (
          deck.slice(0, 3).map((item, i) => {
            const isTop = i === 0;
            const isLeaving = leaving?.key === item.ratingKey;
            const dx = isTop && drag ? drag.dx : 0;
            const dy = isTop && drag ? drag.dy : 0;
            const transform = isLeaving
              ? flingTransform(leaving.dir)
              : isTop && drag
                ? `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`
                : `translateY(${i * 10}px) scale(${1 - i * 0.04})`;
            return (
              <div
                key={item.ratingKey}
                className="absolute inset-x-0 top-0 mx-auto aspect-[2/3] max-h-full w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-800 shadow-xl"
                style={{
                  zIndex: 10 - i,
                  transform,
                  opacity: isLeaving && !leaving.dir ? 0 : 1,
                  transition:
                    isTop && drag && !isLeaving
                      ? 'none'
                      : 'transform 0.22s ease, opacity 0.22s ease',
                  touchAction: 'none',
                }}
                onPointerDown={isTop ? onPointerDown : undefined}
                onPointerMove={isTop ? onPointerMove : undefined}
                onPointerUp={isTop ? onPointerUp : undefined}
                onPointerCancel={isTop ? () => { dragStart.current = null; setDrag(null); } : undefined}
              >
                {item.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.thumbUrl}
                    alt={item.title}
                    draggable={false}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-6 text-center text-slate-500">
                    {item.title}
                  </div>
                )}
                {/* Info gradient */}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-4 pt-12">
                  <div className="text-lg font-bold text-paper">{item.title}</div>
                  <div className="mt-0.5 flex items-center gap-3 text-xs text-slate-300">
                    {item.year && <span>{item.year}</span>}
                    <span className="font-mono">{formatGB(item.sizeBytes)}</span>
                    {item.watched && <span title="You've watched this">👁 watched</span>}
                    {item.requestedByMe && <span className="text-sky-300">requested by you</span>}
                  </div>
                  {(item.imdbRating != null || item.rtScore != null || item.metacritic != null) && (
                    <div className="mt-1 flex items-center gap-3 text-xs text-slate-300">
                      {item.imdbRating != null && (
                        <span title="IMDb rating">⭐ {item.imdbRating.toFixed(1)}</span>
                      )}
                      {item.rtScore != null && (
                        <span title="Rotten Tomatoes">🍅 {item.rtScore}%</span>
                      )}
                      {item.metacritic != null && (
                        <span title="Metacritic">Ⓜ {item.metacritic}</span>
                      )}
                    </div>
                  )}
                </div>
                {/* Drag verdict overlay */}
                {isTop && activeDef && !isLeaving && (
                  <div
                    className={`absolute left-1/2 top-8 -translate-x-1/2 rounded-lg border-2 bg-black/60 px-4 py-1.5 text-lg font-black uppercase tracking-wide ${activeDef.color}`}
                  >
                    {activeDef.label}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Action buttons (desktop + accessibility path) */}
      <div className="mt-4 flex w-full max-w-md items-center justify-center gap-2 pb-2">
        {VERDICT_DEFS.map((v) => (
          <button
            key={v.verdict}
            onClick={() => commit(v)}
            disabled={!top || !!leaving}
            title={`${v.label}${v.dir ? ` (swipe ${v.dir} / ${v.dir} arrow)` : ' (S)'}`}
            className={`flex-1 rounded-lg border bg-panel px-2 py-2 text-xs font-semibold transition-colors hover:bg-slate-800 disabled:opacity-40 ${v.color}`}
          >
            {v.label}
          </button>
        ))}
        <button
          onClick={undo}
          disabled={undoStack.length === 0}
          title="Undo last swipe (U)"
          className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-400 hover:border-slate-500 hover:text-white disabled:opacity-40"
        >
          ↺
        </button>
      </div>
      <p className="pb-2 text-center text-[11px] text-slate-600">
        → want to watch · ↑ loved it · ← not interested · ↓ done with it · S skip · U undo
      </p>
    </div>
  );
}
