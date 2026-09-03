/**
 * FORK: pattern-based library exclusion.
 *
 * A Jellyfin/Emby recommendation plugin can create a library PER USER, and each
 * one reports a `movies`/`tvshows` CollectionType — so they arrive through
 * `getLibraries()` looking exactly like real libraries, and Keeparr adopts them
 * (an empty `managed_section_ids` means "all"). Ticking them off by hand does
 * not hold: the plugin makes another one the next time a user is added, and the
 * new id is managed again on the following scan.
 *
 * So the exclusion is a RULE, not a list of ids: glob patterns matched against
 * the library TITLE, re-evaluated every time the sections are read. A library
 * the plugin creates tomorrow is excluded the moment it appears — no admin
 * round-trip.
 *
 * Discovery still records every library (`setPlexSections` writes the raw list),
 * so removing a pattern un-hides its libraries immediately with no re-scan.
 *
 * Pure module — no DB, no settings imports — so the matcher is unit-testable on
 * its own and can be reused by the settings UI's live preview.
 */

/** Regex metacharacters to escape. `*` and `?` are deliberately absent: those
 *  are the two the glob syntax gives meaning to. */
const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

const compiled = new Map<string, RegExp>();

/** Glob → RegExp, anchored and case-insensitive. `*` = any run of characters
 *  (including none), `?` = exactly one. A pattern with no wildcard is therefore
 *  an exact title match, which is why the UI tells you to write `*Recommend*`. */
function toRegExp(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  const body = pattern
    .replace(REGEX_SPECIALS, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const rx = new RegExp(`^${body}$`, 'i');
  // Patterns come from one admin-edited setting, so this map stays tiny; the
  // bound only guards against a pathological config churning it.
  if (compiled.size > 200) compiled.clear();
  compiled.set(pattern, rx);
  return rx;
}

/** Does this library title match any exclusion pattern? Blank patterns never
 *  match — an empty row in the editor must not hide the whole server. */
export function isSectionExcluded(title: string, patterns: string[]): boolean {
  const name = title.trim();
  return patterns.some((p) => {
    const pattern = p.trim();
    return pattern.length > 0 && toRegExp(pattern).test(name);
  });
}

/** The libraries Keeparr should treat as real. */
export function filterExcludedSections<T extends { title: string }>(
  sections: T[],
  patterns: string[]
): T[] {
  if (patterns.length === 0) return sections; // fast path: the default install
  return sections.filter((s) => !isSectionExcluded(s.title, patterns));
}

/** The inverse — what a pattern is currently hiding, so the Settings card can
 *  name them instead of leaving the admin to guess at an over-broad pattern. */
export function excludedSections<T extends { title: string }>(
  sections: T[],
  patterns: string[]
): T[] {
  if (patterns.length === 0) return [];
  return sections.filter((s) => isSectionExcluded(s.title, patterns));
}

export const MAX_EXCLUSION_PATTERNS = 50;

/** Normalize admin input from the settings PUT: coerce to strings, trim, drop
 *  blanks, de-dupe case-insensitively, cap the count. */
export function normalizeExclusionPatterns(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const pattern = String(entry ?? '').trim();
    if (!pattern) continue;
    const key = pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pattern);
    if (out.length >= MAX_EXCLUSION_PATTERNS) break;
  }
  return out;
}
