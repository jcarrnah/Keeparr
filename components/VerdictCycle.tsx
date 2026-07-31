'use client';

/**
 * FORK (3.6): the card's verdict control — one button that steps through the
 * five verdicts in score order (most protective first) plus an un-voted
 * position, so a click has a direction rather than being an arbitrary carousel.
 * Six positions means overshooting is common, hence shift-click / right-click
 * to step back.
 */
import type { Verdict } from '@/lib/types';
import { NO_VERDICT_META, VERDICT_META, verdictHint } from './verdict-meta';

export default function VerdictCycle({
  verdict,
  busy,
  onStep,
  /** Layout only — the grid card wants a full-width footer button, Browse's
   *  List view a fixed-width one in the action column. */
  className = 'mt-1.5 w-full',
}: {
  verdict: Verdict | null;
  busy: boolean;
  onStep: (back?: boolean) => void;
  className?: string;
}) {
  const meta = verdict ? VERDICT_META[verdict] : NO_VERDICT_META;
  const hint = verdict ? verdictHint(verdict) : 'No vote yet';
  return (
    <button
      type="button"
      // The card itself also steps forward, so the button must not double-fire.
      onClick={(e) => {
        e.stopPropagation();
        onStep(e.shiftKey);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onStep(true);
      }}
      title={`${hint} — click for the next, shift-click or right-click to go back`}
      className={`flex items-center justify-center gap-1 rounded border px-2 py-1 text-[11px] font-semibold transition-colors hover:bg-slate-800 ${className} ${
        meta.color
      } ${busy ? 'opacity-60' : ''}`}
    >
      <span aria-hidden>{meta.icon}</span>
      <span className="truncate">{meta.short}</span>
    </button>
  );
}
