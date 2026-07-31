/**
 * FORK: the one place a verdict's user-facing vocabulary lives — label, colour
 * and glyph. Swipe (`SwipeView`) and the card cycle control (`VerdictCycle`)
 * both read from here, so the two screens can never drift into calling the same
 * stored value different things.
 *
 * Outcome-focused labels (user-chosen); the stored values keep their original
 * names — no migration, and the semantics are unchanged:
 *   Save for later = unseen, keep to watch · Worth keeping = seen, keep ·
 *   Let it go = never watching, releases my claim · Can go = watched, done.
 */
import { VERDICT_POINTS, type Verdict } from '@/lib/types';

export interface VerdictMeta {
  verdict: Verdict;
  /** Full label — swipe buttons and the drag overlay, where there's room. */
  label: string;
  /** Compact label for the card control, where a poster width is all you get. */
  short: string;
  /** Text + border accent (swipe overlay/buttons, and the card control). */
  color: string;
  /** Glyph, so the state never rests on colour alone. */
  icon: string;
}

export const VERDICT_META: Record<Verdict, VerdictMeta> = {
  not_interested: {
    verdict: 'not_interested',
    label: 'Let it go / delete this shit',
    short: 'Let it go',
    color: 'text-rose-400 border-rose-500',
    icon: '✕',
  },
  done_with_it: {
    verdict: 'done_with_it',
    label: "Wouldn't be mad / OK to delete",
    short: "Wouldn't be mad",
    color: 'text-amber-400 border-amber-500',
    icon: '↓',
  },
  dont_care: {
    verdict: 'dont_care',
    label: 'Skip',
    short: 'Skip',
    color: 'text-slate-300 border-slate-500',
    icon: '–',
  },
  want_to_watch: {
    verdict: 'want_to_watch',
    label: 'Save for later',
    short: 'Save for later',
    color: 'text-emerald-400 border-emerald-500',
    icon: '★',
  },
  loved_it: {
    verdict: 'loved_it',
    label: 'Worth keeping',
    short: 'Worth keeping',
    color: 'text-sky-400 border-sky-500',
    icon: '✦',
  },
};

/** The un-voted position of the cycle — styled like the other states so the
 *  control doesn't change shape as you step through it. */
export const NO_VERDICT_META = {
  short: 'No vote',
  color: 'text-slate-400 border-slate-700',
  icon: '·',
};

/** "Worth keeping (−2)" — the scale, spelled out on hover. */
export function verdictHint(verdict: Verdict): string {
  const pts = VERDICT_POINTS[verdict];
  return `${VERDICT_META[verdict].label} (${pts > 0 ? `+${pts}` : pts})`;
}
