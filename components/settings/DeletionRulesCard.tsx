'use client';

/**
 * FORK: rule builder for scheduled-deletion auto-tagging. Rules are condition
 * rows (field / op / value) AND'd together; the nightly 'rules' job tags
 * matches into scheduled_deletions. Kept items and already-tagged items are
 * always excluded server-side, so the preview shows exactly what would be
 * tagged tonight.
 */
import { useCallback, useEffect, useState } from 'react';
import { formatSize } from '@/lib/format';
import {
  DEFAULT_MIN_VOTERS,
  VERDICTS,
  effectiveMinVoters,
  type RuleCondition,
  type Verdict,
} from '@/lib/types';
import { VERDICT_META } from '../verdict-meta';
import { Card, btnCls, btnGhost, inputCls } from './ui';

interface Rule {
  id: number;
  name: string;
  enabled: boolean;
  conditions: Cond[];
  graceDays: number | null;
}
interface Cond {
  field: string;
  op: string;
  value: number | boolean | string | string[];
  /** FORK (3.2): which verdict verdict_count / verdict_by is asking about. */
  verdict?: Verdict;
}
interface Section {
  id: string;
  title: string;
}
interface Voter {
  plexUserId: string;
  username: string | null;
}
interface Preview {
  count: number;
  totalBytes: number;
  sample: { title: string }[];
  /** FORK (3.2): the quorum in force (null = the rule reads no opinions). */
  minVoters?: number | null;
  /** FORK (3.2): matched the conditions but were held back by the baseline —
   *  the difference between this count and the same filter in Browse. */
  heldByQuorum?: number;
  excludedKept?: number;
  excludedTagged?: number;
}

// FORK (3.2): the quorum a set of conditions runs with, mirrored from
// lib/types effectiveMinVoters so the builder can show it before saving. Kept
// as a call to the shared helper rather than a re-implementation — a builder
// that disagreed with the engine would be worse than not showing it at all.
function quorumOf(conditions: Cond[]): number | null {
  return effectiveMinVoters(conditions as RuleCondition[]);
}

const FIELD_DEFS: Record<
  string,
  {
    label: string;
    ops: { value: string; label: string }[];
    kind: 'days' | 'gb' | 'library' | 'bool' | 'score' | 'verdictCount' | 'verdictBy' | 'voters' | 'none';
    /** FORK (3.2): shown under the row — these conditions need explaining. */
    hint?: string;
  }
> = {
  last_watched_any: {
    label: 'Not watched by anyone in',
    ops: [{ value: 'olderThanDays', label: 'more than (days)' }],
    kind: 'days',
  },
  added_at: {
    label: 'Added to library',
    ops: [{ value: 'olderThanDays', label: 'more than (days) ago' }],
    kind: 'days',
  },
  size: {
    label: 'Size on disk',
    ops: [
      { value: 'gtGB', label: 'more than (GB)' },
      { value: 'ltGB', label: 'less than (GB)' },
    ],
    kind: 'gb',
  },
  library: {
    label: 'Library',
    ops: [{ value: 'in', label: 'is one of' }],
    kind: 'library',
  },
  requested: {
    label: 'Requested via Seerr',
    ops: [{ value: 'eq', label: 'is' }],
    kind: 'bool',
  },
  // --- FORK (3.2): match on what the household said ---
  verdict_score: {
    label: 'Household score',
    ops: [
      { value: 'gte', label: 'at least' },
      { value: 'lte', label: 'at most' },
    ],
    kind: 'score',
    hint: 'Positive = they want it gone (+2 “let it go”, +1 “wouldn’t be mad”, −2 “worth keeping”). Keeps and “don’t care” made outside Swipe count too.',
  },
  verdict_count: {
    label: 'People saying',
    ops: [
      { value: 'gte', label: 'at least' },
      { value: 'lte', label: 'at most' },
    ],
    kind: 'verdictCount',
  },
  verdict_by: {
    label: 'A specific person said',
    ops: [{ value: 'eq', label: 'is' }],
    kind: 'verdictBy',
    hint: 'Useful for “the person who requested it is done with it”.',
  },
  min_voters: {
    label: 'Minimum voters',
    ops: [{ value: 'gte', label: 'at least' }],
    kind: 'voters',
    hint: `Overrides the default of ${DEFAULT_MIN_VOTERS}. Set 1 if one clear “no” is enough in your house.`,
  },
  nobody_kept: {
    label: 'Nobody keeps it',
    ops: [{ value: 'eq', label: '—' }],
    kind: 'none',
    hint: 'Always enforced, with or without this row — a keep by anyone protects an item. Add it only to make that visible in the rule.',
  },
};

function defaultCond(field: string): Cond {
  const def = FIELD_DEFS[field];
  switch (def.kind) {
    case 'bool':
      return { field, op: def.ops[0].value, value: false };
    case 'library':
      return { field, op: def.ops[0].value, value: [] };
    case 'none':
      return { field, op: def.ops[0].value, value: true };
    case 'score':
      return { field, op: def.ops[0].value, value: 3 };
    case 'verdictCount':
      return { field, op: def.ops[0].value, value: 2, verdict: 'not_interested' };
    case 'verdictBy':
      return { field, op: def.ops[0].value, value: '', verdict: 'done_with_it' };
    case 'voters':
      return { field, op: def.ops[0].value, value: DEFAULT_MIN_VOTERS };
    default:
      return { field, op: def.ops[0].value, value: 180 };
  }
}

function condSummary(c: Cond, sections: Section[], voters: Voter[]): string {
  const def = FIELD_DEFS[c.field];
  if (!def) return '?';
  if (def.kind === 'library') {
    const names = (c.value as string[]).map(
      (id) => sections.find((s) => s.id === id)?.title ?? id
    );
    return `${def.label} is ${names.join(' / ') || '(none)'}`;
  }
  if (def.kind === 'bool') return `${def.label}: ${c.value ? 'yes' : 'no'}`;
  const op = def.ops.find((o) => o.value === c.op)?.label ?? c.op;
  // FORK (3.2): the vote conditions read as sentences, not "field op value".
  if (def.kind === 'none') return def.label;
  if (def.kind === 'score') return `${def.label} ${op} ${Number(c.value) > 0 ? '+' : ''}${c.value}`;
  if (def.kind === 'voters') return `${def.label}: ${c.value}`;
  const verdictLabel = c.verdict ? VERDICT_META[c.verdict].short : '?';
  if (def.kind === 'verdictCount') return `${def.label} “${verdictLabel}” ${op} ${c.value}`;
  if (def.kind === 'verdictBy') {
    const who =
      voters.find((v) => v.plexUserId === c.value)?.username ?? String(c.value || '(nobody)');
    return `${who} said “${verdictLabel}”`;
  }
  return `${def.label} ${op.replace(/\s*\(.*\)/, '')} ${c.value}${def.kind === 'gb' ? ' GB' : ' days'}`;
}

export default function DeletionRulesCard() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  // FORK (3.2): who the "a specific person said…" condition can name.
  const [voters, setVoters] = useState<Voter[]>([]);
  // Editor state (null = closed; id null = creating a new rule).
  const [editing, setEditing] = useState<{
    id: number | null;
    name: string;
    enabled: boolean;
    graceDays: string; // input text; '' = use global default
    conditions: Cond[];
  } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch('/api/admin/deletion-rules')
      .then((r) => r.json())
      .then((d) => setRules(d.rules ?? []))
      .catch(() => {});
    fetch('/api/sections')
      .then((r) => r.json())
      .then((d) => setSections((d.sections ?? d ?? []).map((s: { id: string; title: string }) => ({ id: String(s.id), title: s.title }))))
      .catch(() => {});
    // Everyone who has logged in — a rule may name someone who hasn't voted
    // yet ("once Sam says he's done with it"), so this isn't the voter list.
    fetch('/api/admin/users')
      .then((r) => r.json())
      .then((d) =>
        setVoters(
          (d.users ?? []).map((u: { plexUserId: string; username: string | null }) => ({
            plexUserId: u.plexUserId,
            username: u.username,
          }))
        )
      )
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  function openEditor(rule?: Rule) {
    setPreview(null);
    setMsg('');
    setEditing(
      rule
        ? {
            id: rule.id,
            name: rule.name,
            enabled: rule.enabled,
            graceDays: rule.graceDays == null ? '' : String(rule.graceDays),
            conditions: rule.conditions.map((c) => ({ ...c })),
          }
        : {
            id: null,
            name: '',
            enabled: false,
            graceDays: '',
            conditions: [defaultCond('last_watched_any')],
          }
    );
  }

  function setCond(i: number, next: Cond) {
    if (!editing) return;
    const conditions = editing.conditions.map((c, j) => (j === i ? next : c));
    setEditing({ ...editing, conditions });
    setPreview(null); // stale once conditions change
  }

  async function runPreview() {
    if (!editing) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/admin/deletion-rules/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conditions: editing.conditions }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setPreview(await res.json());
    } catch {
      setMsg("Couldn't preview — check the conditions.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setMsg('');
    try {
      const body = {
        ...(editing.id != null ? { id: editing.id } : {}),
        name: editing.name,
        enabled: editing.enabled,
        graceDays: editing.graceDays.trim() === '' ? null : Number(editing.graceDays),
        conditions: editing.conditions,
      };
      const res = await fetch('/api/admin/deletion-rules', {
        method: editing.id != null ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      setEditing(null);
      load();
    } catch {
      setMsg("Couldn't save — check the rule (name + at least one valid condition).");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/admin/deletion-rules', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        const d = await res.json();
        setMsg(
          d.cancelledTags > 0
            ? `Rule deleted — ${d.cancelledTags} scheduled tag(s) cancelled with it.`
            : 'Rule deleted.'
        );
      }
      load();
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(rule: Rule) {
    await fetch('/api/admin/deletion-rules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...rule, enabled: !rule.enabled }),
    });
    load();
  }

  // FORK (3.2): the quorum this draft would run with, recomputed as you edit.
  const quorum = editing ? quorumOf(editing.conditions) : null;

  return (
    <Card title="Deletion rules">
      <p className="text-sm text-slate-400 mb-3">
        Auto-tag items for deletion, e.g. “not watched by anyone in 180 days and
        larger than 20 GB.” Rules run nightly, only <em>tag</em> (the purge job
        deletes after the grace period), never touch kept items, and never
        overwrite an existing tag.
      </p>

      {rules.length === 0 && !editing && (
        <p className="text-sm text-slate-500">No rules yet.</p>
      )}
      <ul className="space-y-2">
        {rules.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2"
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={r.enabled}
                onChange={() => toggleEnabled(r)}
                title={r.enabled ? 'Rule is active' : 'Rule is off'}
              />
              <span className="font-medium text-slate-200">{r.name}</span>
            </label>
            <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
              {r.conditions.map((c) => condSummary(c, sections, voters)).join(' AND ')}
              {r.graceDays != null ? ` → ${r.graceDays}d grace` : ''}
            </span>
            <button className={`${btnGhost} !px-2 !py-1 text-xs`} onClick={() => openEditor(r)}>
              Edit
            </button>
            <button
              className={`${btnGhost} !px-2 !py-1 text-xs text-rose-300`}
              disabled={busy}
              onClick={() => remove(r.id)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      {editing ? (
        <div className="mt-4 rounded-md border border-slate-700 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Rule name</label>
              <input
                className={`${inputCls} w-56`}
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="Old big unwatched"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Grace days (blank = default)
              </label>
              <input
                className={`${inputCls} w-32`}
                type="number"
                min={0}
                value={editing.graceDays}
                onChange={(e) => setEditing({ ...editing, graceDays: e.target.value })}
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
              />
              Enabled
            </label>
          </div>

          <div className="mt-3 space-y-2">
            {editing.conditions.map((c, i) => {
              const def = FIELD_DEFS[c.field];
              return (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <select
                    className={`${inputCls} w-56`}
                    value={c.field}
                    onChange={(e) => setCond(i, defaultCond(e.target.value))}
                  >
                    {Object.entries(FIELD_DEFS).map(([f, d]) => (
                      <option key={f} value={f}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className={`${inputCls} w-44`}
                    value={c.op}
                    onChange={(e) => setCond(i, { ...c, op: e.target.value })}
                  >
                    {def.ops.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {def.kind === 'none' ? null : def.kind === 'bool' ? (
                    <select
                      className={`${inputCls} w-24`}
                      value={c.value ? 'yes' : 'no'}
                      onChange={(e) => setCond(i, { ...c, value: e.target.value === 'yes' })}
                    >
                      <option value="yes">yes</option>
                      <option value="no">no</option>
                    </select>
                  ) : def.kind === 'score' ? (
                    /* Signed: "at most −2" is a legitimate way to ask for the
                       titles the household is protective of. */
                    <input
                      className={`${inputCls} w-24`}
                      type="number"
                      value={Number(c.value)}
                      onChange={(e) => setCond(i, { ...c, value: Math.trunc(Number(e.target.value) || 0) })}
                    />
                  ) : def.kind === 'verdictCount' ? (
                    <>
                      <input
                        className={`${inputCls} w-20`}
                        type="number"
                        min={0}
                        value={Number(c.value)}
                        onChange={(e) => setCond(i, { ...c, value: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
                      />
                      <span className="text-xs text-slate-500">people said</span>
                      <select
                        className={`${inputCls} w-44`}
                        value={c.verdict ?? 'not_interested'}
                        onChange={(e) => setCond(i, { ...c, verdict: e.target.value as Verdict })}
                      >
                        {VERDICTS.map((v) => (
                          <option key={v} value={v}>
                            {VERDICT_META[v].short}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : def.kind === 'verdictBy' ? (
                    <>
                      <select
                        className={`${inputCls} w-40`}
                        value={String(c.value ?? '')}
                        onChange={(e) => setCond(i, { ...c, value: e.target.value })}
                      >
                        <option value="">(pick someone)</option>
                        {voters.map((v) => (
                          <option key={v.plexUserId} value={v.plexUserId}>
                            {v.username ?? v.plexUserId}
                          </option>
                        ))}
                      </select>
                      <span className="text-xs text-slate-500">said</span>
                      <select
                        className={`${inputCls} w-44`}
                        value={c.verdict ?? 'done_with_it'}
                        onChange={(e) => setCond(i, { ...c, verdict: e.target.value as Verdict })}
                      >
                        {VERDICTS.map((v) => (
                          <option key={v} value={v}>
                            {VERDICT_META[v].short}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : def.kind === 'voters' ? (
                    <input
                      className={`${inputCls} w-24`}
                      type="number"
                      min={1}
                      value={Number(c.value)}
                      onChange={(e) => setCond(i, { ...c, value: Math.max(1, Math.trunc(Number(e.target.value) || 1)) })}
                    />
                  ) : def.kind === 'library' ? (
                    <div className="flex flex-wrap gap-2">
                      {sections.map((s) => {
                        const sel = (c.value as string[]).includes(s.id);
                        return (
                          <label key={s.id} className="flex items-center gap-1 text-xs text-slate-300">
                            <input
                              type="checkbox"
                              checked={sel}
                              onChange={() => {
                                const cur = c.value as string[];
                                setCond(i, {
                                  ...c,
                                  value: sel ? cur.filter((v) => v !== s.id) : [...cur, s.id],
                                });
                              }}
                            />
                            {s.title}
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <input
                      className={`${inputCls} w-24`}
                      type="number"
                      min={0}
                      value={Number(c.value)}
                      onChange={(e) => setCond(i, { ...c, value: Math.max(0, Number(e.target.value) || 0) })}
                    />
                  )}
                  {editing.conditions.length > 1 && (
                    <button
                      className="text-xs text-slate-500 hover:text-rose-300"
                      title="Remove condition"
                      onClick={() =>
                        setEditing({
                          ...editing,
                          conditions: editing.conditions.filter((_, j) => j !== i),
                        })
                      }
                    >
                      ✕
                    </button>
                  )}
                  {/* FORK (3.2): the vote conditions need a sentence of
                      explanation; basis-full drops it onto its own line. */}
                  {def.hint && (
                    <p className="basis-full text-[11px] leading-snug text-slate-500">{def.hint}</p>
                  )}
                </div>
              );
            })}
          </div>

          {/* FORK (3.2): the quorum, stated before you save rather than
              discovered when the rule mysteriously tags nothing. */}
          {quorum != null && (
            <p className="mt-2 text-xs text-slate-400">
              Needs at least{' '}
              <span className="font-semibold text-slate-200">{quorum}</span>{' '}
              {quorum === 1 ? 'person' : 'different people'} to have weighed in on an item
              {editing.conditions.some((c) => c.field === 'min_voters')
                ? ' (set by this rule).'
                : ` (the default — add a “Minimum voters” condition to change it).`}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              className={`${btnGhost} !px-3 !py-1.5 text-xs`}
              onClick={() =>
                setEditing({
                  ...editing,
                  conditions: [...editing.conditions, defaultCond('size')],
                })
              }
            >
              + Add condition
            </button>
            <button className={`${btnGhost} !px-3 !py-1.5 text-xs`} disabled={busy} onClick={runPreview}>
              Preview matches
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button className={btnGhost} onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className={btnCls} disabled={busy || !editing.name.trim()} onClick={save}>
                Save rule
              </button>
            </div>
          </div>

          {preview && (
            <p className="mt-2 text-xs text-slate-400">
              Would tag <span className="font-semibold text-slate-200">{preview.count}</span>{' '}
              item(s) tonight ({formatSize(preview.totalBytes)})
              {preview.sample.length > 0 && (
                <> — e.g. {preview.sample.slice(0, 5).map((s) => s.title).join(', ')}</>
              )}
              .
            </p>
          )}
          {/* FORK (3.2): a smaller number than the same filter gives in Browse
              should say WHY — Browse applies none of this baseline. */}
          {preview && !!(preview.excludedKept || preview.excludedTagged || preview.heldByQuorum) && (
            <ul className="mt-1 space-y-0.5 text-xs text-amber-400">
              {!!preview.excludedTagged && (
                <li>
                  {preview.excludedTagged} matched but{' '}
                  {preview.excludedTagged === 1 ? 'is' : 'are'} already tagged and counting down.
                </li>
              )}
              {!!preview.excludedKept && (
                <li>{preview.excludedKept} matched but somebody keeps {preview.excludedKept === 1 ? 'it' : 'them'}.</li>
              )}
              {!!preview.heldByQuorum && (
                <li>
                  {preview.heldByQuorum} matched but{' '}
                  {preview.heldByQuorum === 1 ? 'was' : 'were'} held back: fewer than{' '}
                  {preview.minVoters} people have voted on{' '}
                  {preview.heldByQuorum === 1 ? 'it' : 'them'}.
                </li>
              )}
              <li className="text-slate-500">
                Browse’s score filter applies none of these, which is why it lists more.
              </li>
            </ul>
          )}
          {msg && <p className="mt-2 text-xs text-amber-400">{msg}</p>}
        </div>
      ) : (
        <div className="mt-3">
          <button className={btnGhost} onClick={() => openEditor()}>
            + Add rule
          </button>
          {msg && <p className="mt-2 text-xs text-slate-300">{msg}</p>}
        </div>
      )}
    </Card>
  );
}
