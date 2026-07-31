'use client';

/**
 * FORK (3.6): per-user verdict state for one card, stepped by clicking rather
 * than swiped. The five verdicts were only reachable by swiping, so anyone who
 * triaged in Browse produced silent keeps and never appeared in the consensus
 * score — this closes that gap without a second vocabulary.
 *
 * Reuses `POST/DELETE /api/swipe/verdict`, which already replaces a previous
 * verdict and transitions its write-through (keep / "don't care" / paused
 * deletion). Nothing new server-side.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { VERDICT_CYCLE, type Verdict } from '@/lib/types';
import { useToast } from './Toaster';

/** Cycling is fast and each step is a write, so only the state the user LANDS
 *  on is sent. Long enough to absorb a run of clicks, short enough that the
 *  save still feels immediate. */
const SETTLE_MS = 450;

const KEEP_VERDICTS: Verdict[] = ['loved_it', 'want_to_watch'];

export interface VerdictCycleState {
  verdict: Verdict | null;
  /** Derived: these verdicts write a keep server-side (applyVerdict). */
  keptByMe: boolean;
  /** Derived: 'dont_care' writes this user's skip. */
  skipped: boolean;
  /** A write is in flight (or queued). */
  busy: boolean;
  /** Step one position; `back` reverses, so overshooting is cheap to undo. */
  step: (back?: boolean) => void;
}

export function useVerdictCycle(opts: {
  ratingKey: string;
  initial?: Verdict | null;
  onKeptChange?: (ratingKey: string, kept: boolean) => void;
  onSkipChange?: (ratingKey: string, skipped: boolean) => void;
  onDeleteChange?: (ratingKey: string, markedForDelete: boolean) => void;
}): VerdictCycleState {
  const { ratingKey, onKeptChange, onSkipChange, onDeleteChange } = opts;
  const initial = opts.initial ?? null;
  const [verdict, setVerdict] = useState<Verdict | null>(initial);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // `desired` is where the user has clicked to; `confirmed` is what the server
  // last acked. The sender runs until they agree, so a click landing mid-request
  // is never lost — and a failure reverts to the confirmed value, not to a
  // guess. Refs (not state) so back-to-back clicks in one tick all count.
  const desired = useRef<Verdict | null>(initial);
  const confirmed = useRef<Verdict | null>(initial);
  const sending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<Verdict | null>(initial);

  // Latest callbacks, so the sender never captures a stale render's props.
  const cbs = useRef({ onKeptChange, onSkipChange, onDeleteChange });
  cbs.current = { onKeptChange, onSkipChange, onDeleteChange };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      while (desired.current !== confirmed.current) {
        const target = desired.current;
        const res = await fetch('/api/swipe/verdict', {
          method: target ? 'POST' : 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(target ? { ratingKey, verdict: target } : { ratingKey }),
        });
        if (!res.ok) throw new Error(String(res.status));
        confirmed.current = target;
        // Mirror the server's write-through so the parent list (and the card's
        // own badges) agree without a refetch.
        const kept = target != null && KEEP_VERDICTS.includes(target);
        cbs.current.onKeptChange?.(ratingKey, kept);
        cbs.current.onSkipChange?.(ratingKey, target === 'dont_care');
        // applyVerdict clears this user's "OK to delete" for every verdict that
        // writes a keep or a skip; the delete-side verdicts leave it alone.
        if (kept || target === 'dont_care') cbs.current.onDeleteChange?.(ratingKey, false);
      }
    } catch {
      desired.current = confirmed.current;
      current.current = confirmed.current;
      setVerdict(confirmed.current);
      toast("Couldn't save that — change reverted.", 'error');
    } finally {
      sending.current = false;
      setBusy(false);
      // A click that landed while the last request was in flight leaves the two
      // out of step again; pick it up rather than waiting for another click.
      if (desired.current !== confirmed.current) void flush();
    }
  }, [ratingKey, toast]);

  const step = useCallback(
    (back = false) => {
      const i = VERDICT_CYCLE.indexOf(current.current);
      const next =
        VERDICT_CYCLE[
          (i + (back ? -1 : 1) + VERDICT_CYCLE.length) % VERDICT_CYCLE.length
        ];
      current.current = next;
      desired.current = next;
      setVerdict(next); // optimistic
      setBusy(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SETTLE_MS);
    },
    [flush]
  );

  return {
    verdict,
    keptByMe: verdict != null && KEEP_VERDICTS.includes(verdict),
    skipped: verdict === 'dont_care',
    busy,
    step,
  };
}
