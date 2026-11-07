/**
 * FORK: the one place a verdict's user-facing vocabulary lives — label, colour
 * and glyph. Swipe (`SwipeView`) and the card cycle control (`VerdictCycle`)
 * both read from here, so the two screens can never drift into calling the same
 * stored value different things.
 *
 * Labels say what the vote does and how hard (user-chosen); the stored values
 * keep their original names — no migration, and the semantics are unchanged:
 *   Super save vote = loved_it · Save vote = want_to_watch ·
 *   Delete vote = done_with_it · Super delete vote = not_interested.
 * "vote" stays in the short labels on purpose: a card button reading just
 * "Delete" looks like it deletes the title.
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
    label: 'Super delete vote',
    short: 'Super delete vote',
    color: 'text-rose-400 border-rose-500',
    icon: '✕',
  },
  done_with_it: {
    verdict: 'done_with_it',
    label: 'Delete vote',
    short: 'Delete vote',
    color: 'text-amber-400 border-amber-500',
    icon: '←',
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
    label: 'Save vote',
    short: 'Save vote',
    color: 'text-emerald-400 border-emerald-500',
    icon: '★',
  },
  loved_it: {
    verdict: 'loved_it',
    label: 'Super save vote',
    short: 'Super save vote',
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

/** "Super save vote (−2)" — the scale, spelled out on hover. */
export function verdictHint(verdict: Verdict): string {
  const pts = VERDICT_POINTS[verdict];
  return `${VERDICT_META[verdict].label} (${pts > 0 ? `+${pts}` : pts})`;
}
