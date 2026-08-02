/**
 * FORK (3.8): the swipe screens' shared vocabulary for "which list am I
 * swiping?" — the labels and the localStorage keys that remember the choice.
 *
 * The landing page and the deck both offer the choice, so a copy in each would
 * be two places for the labels to drift and two spellings of the same key.
 */
import type { FeedWatchMode } from '@/lib/types';

export type WatchSelection = 'all' | FeedWatchMode;

export const WATCH_LABELS: Record<WatchSelection, string> = {
  all: 'Everything',
  never_played: 'Never played',
  stale_90: 'Not watched in 90d+',
  recent_30: 'Watched recently',
  my_unwatched: 'My unwatched',
};

/** Remembered watch-list filter (predates the landing page — keep the key). */
export const SWIPE_WATCH_KEY = 'keeparr.swipeWatchMode';
/** Remembered library choice ('all' or a section id). */
export const SWIPE_SECTION_KEY = 'keeparr.swipeSection';
/** '1' = send /swipe straight to the deck. */
export const SWIPE_SKIP_LANDING_KEY = 'keeparr.swipeSkipLanding';
