'use client';

/**
 * FORK (3.2): the household's weighted verdict score, as a badge.
 *
 * Browse can now sort and filter by score, and a number you can order by but
 * can't see is useless for checking the ordering is sane — so grid cards and
 * list rows both show it, reading from the same component as the consensus
 * screen's scale. Positive = the household wants it gone (rose), negative =
 * they want it kept (sky), 0 = they looked and shrugged (slate).
 *
 * Renders nothing when nobody has an opinion: an absent score is not a 0, and
 * a library-wide row of grey zeroes would drown the handful of real votes.
 */
export default function ScoreBadge({
  score,
  voters,
  className = '',
}: {
  score?: number;
  voters?: number;
  className?: string;
}) {
  if (score == null || !voters) return null;
  const signed = score > 0 ? `+${score}` : String(score);
  const tone =
    score > 0
      ? 'bg-rose-900/70 text-rose-200 ring-rose-800/60'
      : score < 0
        ? 'bg-sky-900/70 text-sky-200 ring-sky-800/60'
        : 'bg-slate-800/80 text-slate-300 ring-slate-700/60';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ring-1 ${tone} ${className}`}
      title={`Household score ${signed} from ${voters} ${
        voters === 1 ? 'person' : 'people'
      } — positive means they want it gone`}
    >
      {signed}
      <span className="font-sans font-normal opacity-70">
        ·{voters}
      </span>
    </span>
  );
}
