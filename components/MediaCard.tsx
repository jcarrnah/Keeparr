'use client';

import { useState } from 'react';
import type { MediaCardData } from '@/lib/types';
import { formatGB } from '@/lib/format';
import { useKeepState } from './useKeepState';
import { useToast } from './Toaster';
// FORK: the 5-state verdict control (3.6).
import VerdictCycle from './VerdictCycle';
import { useVerdictCycle } from './useVerdictCycle';
// FORK (3.2): the household's weighted score badge.
import ScoreBadge from './ScoreBadge';

// Shared so every page sizes its cards identically. CARD_MIN_W must match the
// md: px in CARD_GRID_CLASS (kept as a literal so Tailwind's scanner sees it);
// below md, phones get ~105px cards so three fit across.
export const CARD_MIN_W = 170;
/** Colors of the not-yet-marked "OK to delete" button (the tour draws a copy). */
export const DELETE_BTN_IDLE_CLASS =
  'border-rose-900/70 text-rose-300 hover:border-rose-700 hover:text-rose-200';
export const CARD_GRID_CLASS =
  'grid gap-2 grid-cols-[repeat(auto-fill,minmax(105px,1fr))] md:gap-3 md:grid-cols-[repeat(auto-fill,minmax(170px,1fr))]';

/** The "you've watched this" eye. Exported so the Keep-page tour can show
 *  people exactly what it looks like. */
export function WatchedBadge({ className = '' }: { className?: string }) {
  return (
    <div
      title="You've watched this"
      aria-label="Watched"
      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-900/75 text-slate-200 ring-1 ring-black/30 ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-3 w-3"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    </div>
  );
}

interface Props {
  item: MediaCardData;
  /** Show the kept state as a toggle the user can flip. */
  interactive?: boolean;
  /** Called after a successful keep toggle (parent may update its list). */
  onKeptChange?: (ratingKey: string, kept: boolean) => void;
  /** Show a per-item "don't care" toggle (library / search / results). */
  skippable?: boolean;
  /** Called after a successful skip toggle. */
  onSkipChange?: (ratingKey: string, skipped: boolean) => void;
  /** Called after a successful "OK to delete" toggle. */
  onDeleteChange?: (ratingKey: string, markedForDelete: boolean) => void;
  /** Optional "you requested this" badge (from Seerr). */
  requested?: boolean;
  /** FORK: admin + Deletion enabled → show a schedule/cancel-deletion button. */
  taggable?: boolean;
  /** FORK: replace keep/"don't care" with the 5-state verdict cycle, so triage
   *  here produces the same votes swiping does. */
  verdictControl?: boolean;
  /** Mark this card's "OK to delete" button as the Keep-page tour's target. */
  tourDeleteTarget?: boolean;
  /** Phone layout: smaller label and badges, and "OK to delete" sits on the
   *  poster instead of under the label, so every card is the same height.
   *  MOBILE_GRID.labelH in lib/keepgrid.ts budgets this label's height. */
  compact?: boolean;
}

export default function MediaCard({
  item,
  interactive = true,
  onKeptChange,
  skippable = false,
  onSkipChange,
  onDeleteChange,
  requested,
  taggable = false,
  verdictControl = false,
  tourDeleteTarget = false,
  compact = false,
}: Props) {
  // FORK: local scheduled-deletion state so tagging updates the badge without
  // a refetch. Initialized from the row; only meaningful when `taggable`.
  const [schedAfter, setSchedAfter] = useState<number | undefined>(item.scheduledDeleteAfter);
  const [schedHeld, setSchedHeld] = useState<boolean>(!!item.scheduledDeleteHeld);
  const [tagBusy, setTagBusy] = useState(false);
  const toast = useToast();

  const onTagClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setTagBusy(true);
    try {
      const tagged = schedAfter != null;
      const res = await fetch('/api/admin/scheduled-deletions', {
        method: tagged ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ratingKey: item.ratingKey }),
      });
      if (!res.ok) throw new Error(String(res.status));
      if (tagged) {
        setSchedAfter(undefined);
        setSchedHeld(false);
      } else {
        const d = await res.json();
        setSchedAfter(d.deleteAfter);
        setSchedHeld(false);
      }
    } catch {
      toast("Couldn't update the deletion tag.", 'error');
    } finally {
      setTagBusy(false);
    }
  };
  // Per user: keptByMe / skipped / markedForDelete / neither (shared logic). An
  // item can also be "kept by others" (item.kept true while not mine) -
  // protected, but their keep is never ours to remove. Snapshot fixed at load.
  const keptByOthers = item.kept && !item.keptByMe;
  const {
    keptByMe: keptByMeDirect,
    skipped: skippedDirect,
    markedForDelete,
    skipBusy,
    deleteBusy,
    toggleKeep,
    toggleSkip,
    toggleDelete,
  } = useKeepState({
    ratingKey: item.ratingKey,
    initialKeptByMe: item.keptByMe,
    initialSkipped: item.skipped,
    initialMarkedForDelete: item.markedForDeleteByMe,
    onKeptChange,
    onSkipChange,
    onDeleteChange,
  });
  // FORK (3.6): with the cycle control the verdict IS this user's decision —
  // applyVerdict writes the keep / "don't care" through — so the badges and the
  // border read from it rather than from the keep hook.
  const cycle = useVerdictCycle({
    ratingKey: item.ratingKey,
    initial: item.myVerdict ?? null,
    onKeptChange,
    onSkipChange,
    onDeleteChange,
  });
  const keptByMe = verdictControl ? cycle.keptByMe : keptByMeDirect;
  const skipped = verdictControl ? cycle.skipped : skippedDirect;
  // Someone else released it (the by-anyone view) — name-less badge; my own
  // mark is shown by its own badge/button.
  const releasedByOther = !!item.markedForDeleteAny && !markedForDelete;

  const toggle = (e?: { shiftKey?: boolean }) => {
    if (!interactive) return;
    // FORK: shift-click steps back through the cycle — six positions makes
    // overshooting common, and a forward-only cycle gets irritating fast.
    if (verdictControl) cycle.step(e?.shiftKey);
    else void toggleKeep();
  };
  const onSkipClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    void toggleSkip();
  };
  const onDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    void toggleDelete();
  };

  // Only "don't care" greys the card out. "OK to delete" stays full-color with a
  // rose ring (a deliberate flag, not a dismissal) so the two read differently.
  const dimmed = skipped;
  const showDelete = !!item.requestedByMe || markedForDelete;
  const deleteButton = showDelete && (
    <button
      type="button"
      onClick={onDeleteClick}
      disabled={deleteBusy}
      data-tour={tourDeleteTarget ? 'feed-card-delete' : undefined}
      className={`w-full border disabled:opacity-60 ${
        compact
          ? 'absolute inset-x-0 bottom-0 rounded-none border-x-0 border-b-0 px-1 py-1 text-[10px] leading-3'
          : 'mt-1.5 rounded px-2 py-1 text-[11px]'
      } ${
        // Over a poster, compact cards use colors that don't flip with the theme.
        compact
          ? markedForDelete
            ? 'border-rose-700 bg-rose-600 font-semibold text-paper'
            : 'border-rose-500/60 bg-ink/80 text-paper'
          : markedForDelete
            ? 'border-rose-700 bg-rose-800/80 font-semibold text-rose-100'
            : DELETE_BTN_IDLE_CLASS
      }`}
    >
      {markedForDelete ? <>&#8634; Never mind</> : 'OK to delete'}
    </button>
  );
  // The status badges too wide to share a compact card's top edge with
  // "Requested" (it moves down a row); "Keep", "Kept" and the trash icon fit.
  const wideStatus = !keptByMe && !markedForDelete && (skipped || releasedByOther);
  // Poster-corner badges sit above the on-poster delete bar on compact cards.
  const cornerBottom = compact && showDelete ? 'bottom-6' : 'bottom-1';
  // Font size stays out of `badge`: two size classes on one element resolve by
  // stylesheet order, not by which was written last.
  const badge = compact
    ? 'absolute right-1 top-1 rounded-full px-1.5 py-0.5'
    : 'absolute right-2 top-2 rounded-full px-2 py-0.5';
  const badgeText = compact ? 'text-[9px]' : 'text-[10px]';

  function onKeyDown(e: React.KeyboardEvent) {
    if (!interactive) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(e);
    }
  }

  // Border encodes the decision: my keep = bold amber frame; my "OK to delete" =
  // bold rose frame; someone else released it = muted rose edge; others' keep =
  // muted amber edge. (Grey/dim is reserved for "don't care".)
  // Use a real 2px border (not a ring): an outward ring gets clipped by the Keep
  // page's overflow-hidden grid, and an inset ring hides behind the poster
  // image. A border frames the card, so it's always fully visible. With
  // box-border (Tailwind default) the card's width holds across the 1px<->2px
  // change; only the poster inside shrinks slightly.
  // FORK: a delete-side verdict ("wouldn't be mad" / "let it go") is a decision
  // too, so it gets the same framing as an explicit "OK to delete".
  const votedGone =
    verdictControl &&
    (cycle.verdict === 'done_with_it' || cycle.verdict === 'not_interested');
  const borderCls = keptByMe
    ? 'border-2 border-brand'
    : markedForDelete || votedGone
      ? 'border-2 border-rose-500'
      : releasedByOther && !skipped
        ? 'border border-rose-800/60'
        : keptByOthers && !skipped
          ? 'border border-amber-700/60'
          : 'border border-slate-800 hover:border-slate-600';

  return (
    <div
      role="button"
      aria-pressed={keptByMe}
      tabIndex={interactive ? 0 : -1}
      onClick={toggle}
      onKeyDown={onKeyDown}
      className={`group relative block w-full overflow-hidden rounded-lg text-left transition-all ${borderCls} ${
        interactive ? 'cursor-pointer' : 'cursor-default'
      } ${dimmed ? 'opacity-50 grayscale' : ''}`}
    >
      <div className="relative aspect-[2/3] w-full bg-slate-800">
        {item.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumbUrl}
            alt={item.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-2 text-center text-xs text-slate-500">
            {item.title}
          </div>
        )}
        {/* Watched marker: small, neutral, bottom-left - never collides with the
            keep/don't-care badges (top corners) or their highlights. */}
        {item.watched && <WatchedBadge className={`absolute left-1 ${cornerBottom}`} />}
        {/* Sonarr/Radarr quality - small, muted, bottom-right (opposite the
            watched eye). Subordinate to the keep/don't-care badges. */}
        {item.quality && (
          <div
            title={
              item.qualityKind === 'profile'
                ? `Quality profile: ${item.quality}`
                : `Quality: ${item.quality}`
            }
            className={`absolute right-1 ${cornerBottom} max-w-[80%] truncate rounded bg-slate-900/75 px-1.5 py-0.5 text-[10px] text-slate-300 ring-1 ring-black/30`}
          >
            {item.quality}
          </div>
        )}
        {compact && deleteButton}
      </div>

      {/* Status badge: my keep wins, then my "OK to delete", then don't care,
          then released-by-someone-else (name-less), then kept-by-others. */}
      {keptByMe ? (
        <div className={`${badge} bg-brand font-bold text-ink ${compact ? 'text-[9px]' : 'text-xs'}`}>
          &#10003; Keep
        </div>
      ) : markedForDelete ? (
        <div
          title="You marked this OK to delete"
          className={`${badge} ${badgeText} bg-rose-600 font-bold text-paper`}
        >
          {/* compact: the on-poster bar already says it; the icon alone fits
              beside a "Requested" badge on a narrow card */}
          &#128465;{compact ? '' : ' OK to delete'}
        </div>
      ) : skipped ? (
        <div className={`${badge} ${badgeText} bg-slate-700 font-semibold text-slate-200`}>
          Don&apos;t care
        </div>
      ) : releasedByOther ? (
        <div className={`${badge} ${badgeText} bg-rose-900/70 font-semibold text-rose-200`}>
          OK to delete
        </div>
      ) : keptByOthers ? (
        <div className={`${badge} ${badgeText} bg-amber-900/80 font-semibold text-amber-200`}>
          Kept
        </div>
      ) : null}
      {/* Left-top badge stack: Requested + (FORK) scheduled-deletion notice. */}
      {(requested || schedAfter != null) && (
        <div className={`absolute flex flex-col items-start gap-1 ${compact ? `left-1 ${wideStatus ? 'top-6' : 'top-1'}` : 'left-2 top-2'}`}>
          {requested && (
            <div className={`rounded-full bg-sky-600 font-semibold text-paper ${compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'}`}>
              Requested
            </div>
          )}
          {schedAfter != null && (
            <div
              title={
                schedHeld
                  ? 'Scheduled for deletion, but paused — someone keeps it. The countdown resumes if all keeps are removed.'
                  : `Scheduled for deletion after ${new Date(schedAfter * 1000).toLocaleDateString()}. Keeping this pauses the deletion.`
              }
              className={`rounded-full font-semibold ${compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'} ${
                schedHeld
                  ? 'bg-slate-700/90 text-slate-200'
                  : 'bg-red-500/90 text-paper'
              }`}
            >
              {schedHeld
                ? '⏸ Deletion paused'
                : `⌛ Leaving ${new Date(schedAfter * 1000).toLocaleDateString()}`}
            </div>
          )}
        </div>
      )}

      <div className={compact ? 'p-1.5' : 'p-2'}>
        <div
          className={`truncate font-medium ${compact ? 'text-xs leading-4' : 'text-sm'}`}
          title={item.title}
        >
          {item.title}
        </div>
        <div
          className={`mt-0.5 flex items-center justify-between gap-1 text-slate-400 ${
            compact ? 'text-[10px] leading-3' : 'text-xs'
          }`}
        >
          <span>{item.year ?? ''}</span>
          {/* FORK (3.2): the household's verdict score, so sorting by it is
              checkable at a glance. Absent until somebody votes. */}
          <ScoreBadge score={item.verdictScore} voters={item.verdictVoters} />
          <span className="font-mono">{formatGB(item.sizeBytes)}</span>
        </div>
        {/* FORK (3.6): the cycle replaces keep + "don't care" — Skip is one of
            its positions, so a separate button would be a second vocabulary. */}
        {verdictControl && (
          <VerdictCycle verdict={cycle.verdict} busy={cycle.busy} onStep={cycle.step} />
        )}
        {skippable && !verdictControl && (
          <button
            type="button"
            onClick={onSkipClick}
            disabled={skipBusy}
            className="mt-1.5 w-full rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:border-slate-500 hover:text-slate-200 disabled:opacity-60"
          >
            {skipped ? <>&#8634; I care after all</> : "I don't care"}
          </button>
        )}
        {/* "OK to delete" - on titles you requested on Seerr (you're the original
            requester signing off). Also shown once marked, so you can always undo. */}
        {!compact && deleteButton}
        {/* FORK: admin schedule/cancel deletion (uses the configured grace). */}
        {taggable && (
          <button
            type="button"
            onClick={onTagClick}
            disabled={tagBusy}
            title={
              schedAfter != null
                ? 'Cancel the scheduled deletion'
                : 'Tag for deletion after the configured grace period'
            }
            className={`mt-1.5 w-full rounded border px-2 py-1 text-[11px] disabled:opacity-60 ${
              schedAfter != null
                ? 'border-red-500/70 bg-red-500/20 font-semibold text-red-300'
                : 'border-slate-700 text-slate-400 hover:border-red-500/70 hover:text-red-300'
            }`}
          >
            {schedAfter != null ? '↺ Cancel deletion' : '⌛ Schedule deletion'}
          </button>
        )}
      </div>
    </div>
  );
}
