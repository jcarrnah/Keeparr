'use client';

/**
 * FORK: title-pattern exclusion for libraries Keeparr should never track.
 *
 * A Jellyfin/Emby recommendation plugin creates a library PER USER, and each one
 * reports as a movie/tvshow library — so Keeparr adopts them all and the real
 * Movies/TV numbers get buried. Unticking them in the picker above doesn't hold:
 * the plugin makes another one the next time a user is added. A pattern does.
 *
 * Excluded libraries are hidden from the picker and the storage mapper entirely
 * (the settings route filters `sections` server-side), so this card is the one
 * place that names them — an over-broad pattern has to be visible.
 *
 * Lives in its own file, and is rendered from ConnectionsPanel by a single line,
 * because that panel is hot upstream code (see FORK_SYNC.md).
 */
import { useCallback, useEffect, useState } from 'react';
import { btnCls, btnGhost, inputCls } from './ui';

interface ExcludedSection {
  id: string;
  title: string;
  type: string;
}

export default function LibraryExclusions({ onSaved }: { onSaved?: () => void }) {
  const [patterns, setPatterns] = useState<string[]>([]);
  const [hidden, setHidden] = useState<ExcludedSection[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await fetch('/api/admin/settings').then((r) => r.json());
      const stored: string[] = d.excludedSectionPatterns ?? [];
      setPatterns(stored);
      setHidden(d.excludedSections ?? []);
      // Only auto-open the editor when there is nothing to show; an install
      // with patterns already set gets the summary line instead.
      setOpen(stored.length > 0);
    } catch {
      /* the panel above already surfaces a failed settings load */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function setAt(i: number, value: string) {
    setPatterns((p) => p.map((v, idx) => (idx === i ? value : v)));
  }
  function removeAt(i: number) {
    setPatterns((p) => p.filter((_, idx) => idx !== i));
  }

  async function save() {
    setSaving(true);
    setMsg('');
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Only this field — the PUT applies what it's given, so saving here
        // can't clobber unsaved edits elsewhere in the panel.
        body: JSON.stringify({ excludedSectionPatterns: patterns }),
      });
      if (!res.ok) {
        setMsg("Couldn't save the exclusions.");
        return;
      }
      await load();
      // Re-read the panel so the picker and storage mapper above drop (or
      // regain) the affected libraries without a page reload.
      onSaved?.();
      // The pattern takes effect immediately for everything that reads the
      // library list, but items an excluded library already contributed live in
      // media_items until the Library sweep tombstones them.
      setMsg('Saved — already-tracked items clear on the next Library scan.');
    } catch {
      setMsg("Couldn't save the exclusions.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 border-t border-slate-800 pt-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-slate-200">Excluded libraries</div>
        {!open && (
          <button type="button" className={btnGhost} onClick={() => setOpen(true)}>
            {patterns.length ? 'Edit patterns' : 'Add a pattern'}
          </button>
        )}
      </div>

      <p className="mb-3 text-sm text-slate-400">
        Hide libraries by name, so ones a media-server plugin creates per user never
        get tracked — no matter how many it adds later. Use <code>*</code> for any run
        of characters (<code>*Recommend*</code>) and <code>?</code> for one. Matching
        ignores case; a pattern with no <code>*</code> must match the whole title.
      </p>

      {hidden.length > 0 && (
        <p className="mb-3 text-sm text-slate-300">
          Currently hiding {hidden.length}{' '}
          {hidden.length === 1 ? 'library' : 'libraries'}:{' '}
          <span className="text-slate-400">{hidden.map((s) => s.title).join(', ')}</span>
        </p>
      )}
      {open && patterns.length > 0 && hidden.length === 0 && (
        <p className="mb-3 text-sm text-amber-400">
          No library matches these patterns — nothing is being hidden.
        </p>
      )}

      {open && (
        <>
          <div className="space-y-2">
            {patterns.map((p, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className={inputCls}
                  value={p}
                  placeholder="*Recommend*"
                  onChange={(e) => setAt(i, e.target.value)}
                />
                <button
                  type="button"
                  className={btnGhost}
                  onClick={() => removeAt(i)}
                  aria-label={`Remove pattern ${i + 1}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              className={btnGhost}
              onClick={() => setPatterns((p) => [...p, ''])}
            >
              Add pattern
            </button>
            <button type="button" className={btnCls} disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save exclusions'}
            </button>
            {msg && <span className="text-sm text-slate-400">{msg}</span>}
          </div>
        </>
      )}
    </div>
  );
}
