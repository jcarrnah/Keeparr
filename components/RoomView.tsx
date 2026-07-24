'use client';

/**
 * FORK: a live "movie night" swipe room. Everyone in the room swipes the SAME
 * ordered deck; the room lands on the first title EVERYONE currently present
 * swipes "want to watch". Transport is short polling (~2s) — no websockets, no
 * new deps. Right = want, left = pass; buttons + arrow keys cover desktop.
 */
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatGB, formatRuntime } from '@/lib/format';
import type { MediaCardData, RoomState } from '@/lib/types';
import { copyText } from '@/lib/clipboard';
import { useToast } from './Toaster';

const POLL_MS = 2000;
const SWIPE_THRESHOLD = 90;

export default function RoomView({ code }: { code: string }) {
  const [state, setState] = useState<RoomState | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [deck, setDeck] = useState<MediaCardData[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [leaving, setLeaving] = useState<{ key: string; want: boolean } | null>(null);
  const toast = useToast();
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const deckSeq = useRef(0);
  const joined = useRef(false);

  const matched = state?.status === 'matched' ? state.matched : null;
  const closed = state?.status === 'closed';

  // Join once on mount; leave (best-effort) on unmount.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/swipe/rooms/${code}/join`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (alive) setFatal(body.error === 'room_not_found' ? 'not_found' : (body.error || 'error'));
          return;
        }
        const { state: s } = await res.json();
        if (alive) {
          setState(s);
          joined.current = true;
        }
      } catch {
        if (alive) setFatal('error');
      }
    })();
    return () => {
      alive = false;
      if (joined.current) {
        // Fire-and-forget; keepalive lets it complete during navigation.
        try {
          fetch(`/api/swipe/rooms/${code}/leave`, { method: 'POST', keepalive: true });
        } catch { /* ignore */ }
      }
    };
  }, [code]);

  // Poll the room while it's live.
  useEffect(() => {
    if (!joined.current && !state) return;
    if (matched || closed) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/swipe/rooms/${code}`);
        if (!res.ok) return;
        const { state: s } = await res.json();
        setState(s);
      } catch { /* transient — next tick retries */ }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [code, state, matched, closed]);

  const loadDeck = useCallback(
    async (replace: boolean) => {
      const seq = ++deckSeq.current;
      try {
        const d = await fetch(`/api/swipe/rooms/${code}/deck?limit=30`).then((r) => r.json());
        if (seq !== deckSeq.current) return;
        setRemaining(d.remaining ?? null);
        setDeck((cur) => {
          if (replace) return d.items ?? [];
          const have = new Set(cur.map((i) => i.ratingKey));
          return [...cur, ...(d.items ?? []).filter((i: MediaCardData) => !have.has(i.ratingKey))];
        });
      } catch {
        if (seq === deckSeq.current) toast("Couldn't load the deck.", 'error');
      }
    },
    [code, toast]
  );

  // Load the deck once we're a confirmed member.
  useEffect(() => {
    if (state && !matched && !closed) void loadDeck(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.code]);

  const top = deck[0] ?? null;

  const vote = useCallback(
    (want: boolean) => {
      const item = deck[0];
      if (!item || leaving || matched || closed) return;
      setLeaving({ key: item.ratingKey, want });
      setDrag(null);
      setTimeout(() => {
        setLeaving(null);
        setDeck((cur) => cur.slice(1));
        setRemaining((r) => (r == null ? r : Math.max(0, r - 1)));
        void fetch(`/api/swipe/rooms/${code}/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ratingKey: item.ratingKey, want }),
        })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (data?.state) setState(data.state); // may carry the match
          })
          .catch(() => toast("Couldn't record that swipe.", 'error'));
      }, 200);
    },
    [deck, leaving, matched, closed, code, toast]
  );

  // Top up as the local stack runs low.
  useEffect(() => {
    if (deck.length > 0 && deck.length < 5 && (remaining ?? 0) > deck.length) {
      void loadDeck(false);
    }
  }, [deck.length, remaining, loadDeck]);

  // Keyboard: ← pass, → want.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); vote(true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); vote(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vote]);

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
    if (Math.abs(drag.dx) >= SWIPE_THRESHOLD) vote(drag.dx > 0);
    else setDrag(null);
  }

  const activeWant = drag && Math.abs(drag.dx) >= SWIPE_THRESHOLD ? drag.dx > 0 : null;

  if (fatal) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg text-slate-300">
          {fatal === 'not_found' ? "That room doesn't exist (or it's over)." : 'Something went wrong joining the room.'}
        </p>
        <Link href="/swipe/matches" className="text-sm text-brand underline">
          Back to matches
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-md flex-col px-4 py-4">
      {/* Header: code + roster */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Movie night</h1>
          <button
            onClick={() => { void copyText(code); toast('Code copied', 'success'); }}
            title="Copy the room code"
            className="mt-0.5 font-mono text-2xl font-black tracking-[0.3em] text-brand hover:text-brand-light"
          >
            {code}
          </button>
          <p className="text-[11px] text-slate-500">Share this code · tap to copy</p>
        </div>
        <Link href="/swipe/matches" className="mt-1 text-xs text-slate-400 underline hover:text-white">
          Leave
        </Link>
      </div>

      {/* Roster */}
      {state && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {state.members.map((m) => (
            <span
              key={m.plexUserId}
              title={m.active ? `${m.votes} swiped` : 'idle'}
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                m.active ? 'bg-slate-700 text-slate-100' : 'bg-slate-800 text-slate-500'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${m.active ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              {m.username || 'guest'}{m.isMe ? ' (you)' : ''}
              <span className="text-slate-500">·{m.votes}</span>
            </span>
          ))}
        </div>
      )}

      {/* Waiting banner — you can already swipe; a match just needs 2+ present. */}
      {!matched && !closed && (state?.activeCount ?? 0) < 2 && (
        <p className="mt-3 rounded-lg bg-slate-800/70 px-3 py-2 text-center text-xs text-slate-400">
          Waiting for others — share code{' '}
          <span className="font-mono font-bold text-brand">{code}</span>. Start swiping now;
          a match needs at least 2 of you.
        </p>
      )}

      {/* Body */}
      <div className="relative mt-4 w-full flex-1 min-h-0 select-none">
        {matched ? (
          <MatchOverlay matched={matched} members={state?.members ?? []} />
        ) : closed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-slate-400">
            <p className="text-lg">This room has closed.</p>
            <Link href="/swipe/matches" className="text-sm text-brand underline">Back to matches</Link>
          </div>
        ) : deck.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-slate-400">
            <p>You've swiped everything. Hang tight while the others catch up — a match can still land.</p>
          </div>
        ) : (
          <CardStack {...{ deck, drag, leaving, activeWant, onPointerDown, onPointerMove, onPointerUp, setDrag, dragStart }} />
        )}
      </div>

      {/* Actions */}
      {!matched && !closed && (
        <>
          <div className="mt-4 flex items-center justify-center gap-3 pb-1">
            <button
              onClick={() => vote(false)}
              disabled={!top || !!leaving}
              className="flex-1 rounded-lg border border-rose-500 bg-panel px-3 py-2.5 text-sm font-semibold text-rose-400 transition-colors hover:bg-slate-800 disabled:opacity-40"
            >
              ✕ Pass
            </button>
            <button
              onClick={() => vote(true)}
              disabled={!top || !!leaving}
              className="flex-1 rounded-lg border border-emerald-500 bg-panel px-3 py-2.5 text-sm font-semibold text-emerald-400 transition-colors hover:bg-slate-800 disabled:opacity-40"
            >
              ♥ Want to watch
            </button>
          </div>
          <p className="pb-1 text-center text-[11px] text-slate-600">
            → want · ← pass{remaining != null ? ` · ${remaining} left for you` : ''}
          </p>
        </>
      )}
    </div>
  );
}

/** Positioned card stack (top 3). Kept as a child so the "waiting" and normal
 *  states can both render it without duplicating the markup. */
function CardStack({
  deck, drag, leaving, activeWant, onPointerDown, onPointerMove, onPointerUp, setDrag, dragStart,
}: {
  deck: MediaCardData[];
  drag: { dx: number; dy: number } | null;
  leaving: { key: string; want: boolean } | null;
  activeWant: boolean | null;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  setDrag: (v: { dx: number; dy: number } | null) => void;
  dragStart: React.MutableRefObject<{ x: number; y: number } | null>;
}) {
  return (
    <div className="absolute inset-0">
      {deck.slice(0, 3).map((item, i) => {
        const isTop = i === 0;
        const isLeaving = leaving?.key === item.ratingKey;
        const dx = isTop && drag ? drag.dx : 0;
        const transform = isLeaving
          ? leaving!.want
            ? 'translate(120vw,0) rotate(20deg)'
            : 'translate(-120vw,0) rotate(-20deg)'
          : isTop && drag
            ? `translate(${dx}px, ${drag.dy}px) rotate(${dx / 18}deg)`
            : `translateY(${i * 10}px) scale(${1 - i * 0.04})`;
        return (
          <div
            key={item.ratingKey}
            className="absolute inset-x-0 top-0 mx-auto aspect-[2/3] max-h-full w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-800 shadow-xl"
            style={{
              zIndex: 10 - i,
              transform,
              transition: isTop && drag && !isLeaving ? 'none' : 'transform 0.2s ease',
              touchAction: 'none',
            }}
            onPointerDown={isTop ? onPointerDown : undefined}
            onPointerMove={isTop ? onPointerMove : undefined}
            onPointerUp={isTop ? onPointerUp : undefined}
            onPointerCancel={isTop ? () => { dragStart.current = null; setDrag(null); } : undefined}
          >
            {item.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.thumbUrl} alt={item.title} draggable={false} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-slate-500">{item.title}</div>
            )}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-4 pt-12">
              <div className="text-lg font-bold text-paper">{item.title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-300">
                {item.year && <span>{item.year}</span>}
                {item.runtimeMinutes != null && <span>{formatRuntime(item.runtimeMinutes)}</span>}
                <span className="font-mono">{formatGB(item.sizeBytes)}</span>
                {item.imdbRating != null && <span title="IMDb">⭐ {item.imdbRating.toFixed(1)}</span>}
              </div>
              {item.genres && item.genres.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {item.genres.slice(0, 3).map((g) => (
                    <span key={g} className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-200">{g}</span>
                  ))}
                </div>
              )}
              {item.overview && <p className="mt-1.5 line-clamp-3 text-xs leading-snug text-slate-300/90">{item.overview}</p>}
            </div>
            {isTop && activeWant != null && !isLeaving && (
              <div
                className={`absolute top-8 rounded-lg border-2 bg-black/60 px-4 py-1.5 text-lg font-black uppercase tracking-wide ${
                  activeWant ? 'right-6 border-emerald-500 text-emerald-400' : 'left-6 border-rose-500 text-rose-400'
                }`}
              >
                {activeWant ? 'Want' : 'Pass'}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The celebration once the room agrees. */
function MatchOverlay({
  matched,
  members,
}: {
  matched: MediaCardData;
  members: RoomState['members'];
}) {
  const names = members.filter((m) => m.active).map((m) => (m.isMe ? 'you' : m.username || 'guest'));
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm font-semibold uppercase tracking-widest text-emerald-400">It's a match! 🍿</p>
      <div className="relative aspect-[2/3] w-44 overflow-hidden rounded-xl border border-emerald-500/60 shadow-xl">
        {matched.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={matched.thumbUrl} alt={matched.title} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-slate-400">{matched.title}</div>
        )}
      </div>
      <div>
        <div className="text-xl font-bold">{matched.title}</div>
        {matched.year && <div className="text-sm text-slate-400">{matched.year}</div>}
      </div>
      <p className="max-w-xs text-sm text-slate-400">
        Everyone wanted it{names.length ? `: ${names.join(', ')}` : ''}. Enjoy the show!
      </p>
      <Link href="/swipe/matches" className="mt-1 text-sm text-brand underline">
        Back to matches
      </Link>
    </div>
  );
}
