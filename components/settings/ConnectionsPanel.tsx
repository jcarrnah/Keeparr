'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatSize } from '@/lib/format';
import { Card, CardColumns, btnCls, btnGhost, inputCls } from './ui';
import MatchHealthCard from './MatchHealthCard';

/**
 * A unique id for a new instance row. `crypto.randomUUID()` only exists in a
 * secure context (HTTPS or localhost) — on a plain-HTTP LAN deployment it's
 * undefined and would throw, so fall back to getRandomValues (available in
 * insecure contexts) and finally a timestamp+random string.
 */
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const b = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall through */
  }
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

interface Parts {
  ssl: boolean;
  host: string;
  port: string;
  base: string;
}
interface DiscoveredServer {
  name: string;
  machineId: string;
  owned: boolean;
  accessToken: string | null;
  connections: {
    uri: string;
    local: boolean;
    relay: boolean;
    address: string;
    port: number;
    protocol: string;
  }[];
}
interface JobRow {
  jobId: string;
  lastStatus: string;
  lastMessage: string | null;
}
interface SectionInfo {
  id: string;
  title: string;
  type: string;
  paths?: string[];
}

function parseUrl(url: string | null): Parts {
  if (!url) return { ssl: false, host: '', port: '', base: '' };
  try {
    const u = new URL(url);
    return {
      ssl: u.protocol === 'https:',
      host: u.hostname,
      port: u.port,
      base: u.pathname.replace(/\/$/, ''),
    };
  } catch {
    return { ssl: false, host: url, port: '', base: '' };
  }
}
function buildUrl(p: Parts): string {
  const host = p.host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  if (!host) return '';
  const proto = p.ssl ? 'https' : 'http';
  const port = p.port ? `:${p.port}` : '';
  let base = p.base.trim();
  if (base && !base.startsWith('/')) base = `/${base}`;
  return `${proto}://${host}${port}${base.replace(/\/$/, '')}`;
}

function ServiceFields({
  parts,
  setParts,
  showBase,
}: {
  parts: Parts;
  setParts: (p: Parts) => void;
  showBase?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-xs text-slate-400">
        Hostname or IP
        <div className="mt-1 flex items-stretch">
          {/* Shows the protocol that gets prepended (follows the SSL toggle). */}
          <span className="inline-flex items-center rounded-l-md border border-r-0 border-slate-700 bg-slate-900 px-2 font-mono text-xs text-slate-400">
            {parts.ssl ? 'https://' : 'http://'}
          </span>
          <input
            className="w-40 rounded-r-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm focus:border-brand focus:outline-none"
            placeholder="192.168.1.10"
            value={parts.host}
            onChange={(e) => setParts({ ...parts, host: e.target.value })}
          />
        </div>
      </label>
      <label className="text-xs text-slate-400">
        Port
        <input
          className={`${inputCls} mt-1 w-24`}
          placeholder="32400"
          value={parts.port}
          onChange={(e) => setParts({ ...parts, port: e.target.value })}
        />
      </label>
      {showBase && (
        <label className="text-xs text-slate-400">
          URL base
          <input
            className={`${inputCls} mt-1 w-32`}
            placeholder="/ (optional)"
            value={parts.base}
            onChange={(e) => setParts({ ...parts, base: e.target.value })}
          />
        </label>
      )}
      <label className="flex items-center gap-2 text-sm text-slate-400 pb-2">
        <input
          type="checkbox"
          checked={parts.ssl}
          onChange={(e) => setParts({ ...parts, ssl: e.target.checked })}
        />
        Use SSL
      </label>
    </div>
  );
}

interface ArrRow {
  id: string;
  name: string;
  parts: Parts;
  apiKey: string;
  hasKey: boolean;
}

const emptyParts = (): Parts => ({ ssl: false, host: '', port: '', base: '' });

/** Repeatable Sonarr/Radarr instances (N per app), each with its own Test. */
function ArrCard({
  title,
  kind,
  rows,
  setRows,
  test,
  onTest,
}: {
  title: string;
  kind: 'sonarr' | 'radarr';
  rows: ArrRow[];
  setRows: (rows: ArrRow[]) => void;
  test: Record<string, string>;
  onTest: (idx: number) => void;
}) {
  const update = (idx: number, patch: Partial<ArrRow>) =>
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const add = () =>
    setRows([
      ...rows,
      { id: newId(), name: '', parts: emptyParts(), apiKey: '', hasKey: false },
    ]);
  const remove = (idx: number) => setRows(rows.filter((_, i) => i !== idx));

  return (
    <Card title={title}>
      {rows.length === 0 && (
        <p className="mb-3 text-sm text-slate-400">
          No instances. Add one to pull quality + tags into the Quality view.
        </p>
      )}
      <div className="space-y-4">
        {rows.map((row, idx) => (
          <div key={row.id} className="rounded-lg border border-slate-700 p-3">
            <div className="mb-2 flex items-center gap-2">
              <input
                className={`${inputCls} w-44`}
                placeholder="Name (e.g. 4K, HD)"
                value={row.name}
                onChange={(e) => update(idx, { name: e.target.value })}
              />
              <button
                onClick={() => remove(idx)}
                className={`${btnGhost} ml-auto text-xs`}
                type="button"
              >
                Remove
              </button>
            </div>
            <ServiceFields parts={row.parts} setParts={(p) => update(idx, { parts: p })} showBase />
            <label className="mt-3 mb-1 block text-sm text-slate-400">
              API key {row.hasKey && '(saved — leave blank to keep)'}
            </label>
            <input
              className={`${inputCls} max-w-md`}
              type="password"
              value={row.apiKey}
              onChange={(e) => update(idx, { apiKey: e.target.value })}
            />
            <div className="mt-3 flex items-center gap-3">
              <button onClick={() => onTest(idx)} className={btnGhost} type="button">
                Test
              </button>
              {test[`${kind}-${row.id}`] && (
                <span className="text-sm text-slate-400">{test[`${kind}-${row.id}`]}</span>
              )}
            </div>
          </div>
        ))}
      </div>
      <button onClick={add} className={`${btnGhost} mt-3`} type="button">
        + Add {kind === 'sonarr' ? 'Sonarr' : 'Radarr'} instance
      </button>
    </Card>
  );
}

type ServerType = 'plex' | 'jellyfin' | 'emby';
const SERVER_LABEL: Record<ServerType, string> = {
  plex: 'Plex',
  jellyfin: 'Jellyfin',
  emby: 'Emby',
};

export default function ConnectionsPanel() {
  const [serverType, setServerType] = useState<ServerType>('plex');
  const [plex, setPlex] = useState<Parts>({ ssl: false, host: '', port: '', base: '' });
  const [plexConfigured, setPlexConfigured] = useState(false);
  const [plexName, setPlexName] = useState<string | null>(null);
  const [taut, setTaut] = useState<Parts>({ ssl: false, host: '', port: '', base: '' });
  const [tautKey, setTautKey] = useState('');
  const [tautConfigured, setTautConfigured] = useState(false);
  const [seerr, setSeerr] = useState<Parts>({ ssl: false, host: '', port: '', base: '' });
  const [seerrKey, setSeerrKey] = useState('');
  const [seerrConfigured, setSeerrConfigured] = useState(false);
  const [sonarr, setSonarr] = useState<ArrRow[]>([]);
  const [radarr, setRadarr] = useState<ArrRow[]>([]);

  const [servers, setServers] = useState<DiscoveredServer[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [test, setTest] = useState<Record<string, string>>({});
  const [libMsg, setLibMsg] = useState('');
  const [scan, setScan] = useState<JobRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  // Managed libraries + storage (libraries depend on Plex being connected).
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [managed, setManaged] = useState<Set<string>>(new Set());
  const [allManaged, setAllManaged] = useState(true);
  const [storagePaths, setStoragePaths] = useState<Record<string, string>>({});
  const [storageMsg, setStorageMsg] = useState<Record<string, string>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const d = await fetch('/api/admin/settings').then((r) => r.json());
    setServerType((d.mediaServerType as ServerType) ?? 'plex');
    setPlex(parseUrl(d.plex.baseUrl));
    setPlexConfigured(!!d.plex.configured);
    setPlexName(
      d.mediaServer?.name ?? d.plex.serverName ?? d.plex.machineId ?? null
    );
    setTaut(parseUrl(d.tautulli.url));
    setTautConfigured(!!d.tautulli.configured);
    setSeerr(parseUrl(d.seerr.url));
    setSeerrConfigured(!!d.seerr.configured);
    const toRows = (arr: { id: string; name: string; url: string; hasKey: boolean }[]) =>
      (arr ?? []).map((i) => ({
        id: i.id,
        name: i.name,
        parts: parseUrl(i.url),
        apiKey: '',
        hasKey: !!i.hasKey,
      }));
    setSonarr(toRows(d.sonarr?.instances));
    setRadarr(toRows(d.radarr?.instances));
    setSections(d.sections ?? []);
    const mgd: string[] = d.managedSectionIds ?? [];
    setAllManaged(mgd.length === 0);
    setManaged(new Set(mgd));
    const saved = new Map(
      (d.storageMappings ?? []).map((m: { sectionId: string; path: string }) => [
        m.sectionId,
        m.path,
      ])
    );
    const paths: Record<string, string> = {};
    for (const s of d.sections ?? []) {
      paths[s.id] = (saved.get(s.id) as string) ?? s.paths?.[0] ?? '';
    }
    setStoragePaths(paths);
  }, []);

  const isManaged = (id: string) => allManaged || managed.has(id);
  function toggleManaged(id: string, on: boolean) {
    const base = allManaged ? new Set(sections.map((s) => s.id)) : new Set(managed);
    if (on) base.add(id);
    else base.delete(id);
    setAllManaged(false);
    setManaged(base);
  }

  async function checkPath(id: string) {
    const path = (storagePaths[id] ?? '').trim();
    if (!path) return;
    setStorageMsg((m) => ({ ...m, [id]: 'Checking…' }));
    const r = await fetch(
      `/api/admin/storage-check?path=${encodeURIComponent(path)}`
    ).then((x) => x.json());
    setStorageMsg((m) => ({
      ...m,
      [id]: r.ok
        ? `OK — ${formatSize(r.freeBytes)} free of ${formatSize(r.totalBytes)}`
        : `Not accessible (${r.error})`,
    }));
  }

  const loadScan = useCallback(async () => {
    const d = await fetch('/api/admin/jobs').then((r) => r.json());
    const lib = (d.jobs ?? []).find((j: JobRow) => j.jobId === 'library') ?? null;
    setScan(lib);
    return lib as JobRow | null;
  }, []);

  useEffect(() => {
    load();
    loadScan();
  }, [load, loadScan]);

  // Poll the library scan while it's running.
  useEffect(() => {
    if (scan?.lastStatus === 'running' && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const s = await loadScan();
        if (s?.lastStatus !== 'running' && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, 2000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [scan?.lastStatus, loadScan]);

  async function discover() {
    setDiscovering(true);
    setServers(null);
    try {
      const d = await fetch('/api/admin/plex-servers').then((r) => r.json());
      setServers(d.servers ?? []);
    } finally {
      setDiscovering(false);
    }
  }

  async function connectServer(srv: DiscoveredServer, uri: string) {
    setSaving(true);
    setMsg('');
    try {
      const t = await fetch('/api/admin/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'plex', url: uri, token: srv.accessToken }),
      }).then((r) => r.json());
      if (!t.ok) {
        // The reachability test can fail even for a valid server (e.g. a
        // relay/remote URL not routable from the container). Don't silently
        // drop the click — let the admin save it anyway.
        const proceed = window.confirm(
          `Couldn't reach ${uri}\n(${t.message ?? 'connection test failed'}).\n\n` +
            `Save this connection anyway?`
        );
        if (!proceed) {
          setMsg(`Did not connect: ${t.message ?? 'connection test failed'}.`);
          return;
        }
      }
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plexServer: {
            machineId: srv.machineId,
            baseUrl: uri,
            serverToken: srv.accessToken,
            serverName: srv.name,
          },
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setMsg(`Connected to ${srv.name}.`);
      setServers(null);
      await load();
    } catch {
      // Discovered-servers list stays visible for a retry click.
      setMsg(`Couldn't connect to ${srv.name} — nothing was saved.`);
    } finally {
      setSaving(false);
    }
  }

  async function testConn(service: 'plex' | 'tautulli' | 'seerr') {
    const url =
      service === 'plex' ? buildUrl(plex) : service === 'tautulli' ? buildUrl(taut) : buildUrl(seerr);
    const apiKey = service === 'tautulli' ? tautKey : service === 'seerr' ? seerrKey : undefined;
    setTest((m) => ({ ...m, [service]: 'Testing…' }));
    const r = await fetch('/api/admin/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, url, apiKey }),
    }).then((x) => x.json());
    setTest((m) => ({ ...m, [service]: r.message ?? (r.ok ? 'OK' : 'Failed') }));
  }

  async function testArrInstance(kind: 'sonarr' | 'radarr', idx: number) {
    const row = (kind === 'sonarr' ? sonarr : radarr)[idx];
    const key = `${kind}-${row.id}`;
    // Need either a freshly-typed key or a saved one (re-test by instance id).
    if (!row.apiKey && !row.hasKey) {
      setTest((m) => ({ ...m, [key]: 'Enter the API key to test.' }));
      return;
    }
    setTest((m) => ({ ...m, [key]: 'Testing…' }));
    const r = await fetch('/api/admin/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service: kind,
        url: buildUrl(row.parts),
        apiKey: row.apiKey || undefined,
        instanceId: row.id,
      }),
    }).then((x) => x.json());
    setTest((m) => ({ ...m, [key]: r.message ?? (r.ok ? 'OK' : 'Failed') }));
  }

  const toInstancesBody = (rows: ArrRow[]) =>
    rows
      .filter((r) => buildUrl(r.parts))
      .map((r) => ({
        id: r.id,
        name: r.name.trim(),
        url: buildUrl(r.parts),
        apiKey: r.apiKey || undefined,
      }));

  async function save() {
    setSaving(true);
    setMsg('');
    try {
      const storageMappings = Object.entries(storagePaths)
        .map(([sectionId, path]) => ({ sectionId, path: (path ?? '').trim() }))
        .filter((m) => m.path.length > 0);
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(buildUrl(plex) ? { plexBaseUrl: buildUrl(plex) } : {}),
          tautulli: { url: buildUrl(taut), apiKey: tautKey || undefined },
          seerr: { url: buildUrl(seerr), apiKey: seerrKey || undefined },
          sonarrInstances: toInstancesBody(sonarr),
          radarrInstances: toInstancesBody(radarr),
          managedSectionIds: allManaged ? [] : [...managed],
          storageMappings,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // Only on success — a failed save must keep the typed API keys in their
      // inputs so the admin can just hit Save again instead of re-typing them.
      setTautKey('');
      setSeerrKey('');
      setMsg('Saved.');
      await load();
    } catch {
      setMsg("Couldn't save — connections unchanged.");
    } finally {
      setSaving(false);
    }
  }

  async function syncLibraries() {
    setLibMsg('Syncing…');
    const r = await fetch('/api/admin/sync-libraries', { method: 'POST' }).then((x) => x.json());
    setLibMsg(r.count != null ? `Found ${r.count} libraries.` : `Failed (${r.error ?? '?'})`);
  }
  async function manualScan() {
    await fetch('/api/admin/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job: 'library' }),
    });
    await loadScan();
  }

  return (
    <div>
      <CardColumns>
      <Card title={SERVER_LABEL[serverType]}>
        {plexConfigured ? (
          <p className="text-sm text-slate-300 mb-3">
            Connected to <span className="text-white font-medium">{plexName}</span>.
          </p>
        ) : (
          <p className="text-sm text-amber-400 mb-3">
            No {SERVER_LABEL[serverType]} server connected yet.
          </p>
        )}

        {/* Plex connects here (discover or manual). Jellyfin/Emby are connected
            during sign-in (URL at setup + the owner's token), so there's no
            connect form — just library sync below. */}
        {serverType === 'plex' ? (
          <>
            <button onClick={discover} disabled={discovering} className={btnGhost}>
              {discovering ? 'Discovering…' : 'Discover servers'}
            </button>
            {servers && servers.length === 0 && (
              <p className="text-sm text-slate-400 mt-3">No servers found.</p>
            )}
            {servers && servers.length > 0 && (
              <div className="mt-4 space-y-3">
                {servers.map((s) => (
                  <div key={s.machineId} className="rounded-lg border border-slate-700 p-3">
                    <div className="font-medium">
                      {s.name} {s.owned && <span className="text-xs text-brand">(owned)</span>}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {s.connections.map((c) => {
                        // Prefer the raw http://ip:port for LAN-local connections
                        // (reliably reachable from a container); the .plex.direct
                        // uri needs public DNS + HTTPS and often fails here.
                        const connectUrl =
                          c.local && c.address && c.port
                            ? `http://${c.address}:${c.port}`
                            : c.uri;
                        let host = connectUrl;
                        try {
                          host = new URL(connectUrl).host;
                        } catch {
                          /* keep raw */
                        }
                        return (
                          <button
                            key={c.uri}
                            onClick={() => connectServer(s, connectUrl)}
                            disabled={saving}
                            className={`${btnGhost} text-xs`}
                            title={connectUrl}
                          >
                            {c.local ? 'Local' : c.relay ? 'Relay' : 'Remote'}: {host}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 border-t border-slate-800 pt-3">
              <p className="text-sm text-slate-400 mb-2">Or set the connection manually:</p>
              <ServiceFields parts={plex} setParts={setPlex} />
              <div className="mt-3 flex items-center gap-3">
                <button onClick={() => testConn('plex')} className={btnGhost} type="button">
                  Test
                </button>
                {test.plex && <span className="text-sm text-slate-400">{test.plex}</span>}
              </div>
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-500 mb-1">
            Connected at sign-in. Re-sync libraries below if you add a new one.
          </p>
        )}

        {plexConfigured && (
          <div className="mt-4 border-t border-slate-800 pt-3 flex flex-wrap items-center gap-3">
            <button onClick={syncLibraries} className={btnGhost} type="button">
              Sync libraries
            </button>
            <button
              onClick={manualScan}
              disabled={scan?.lastStatus === 'running'}
              className={btnGhost}
              type="button"
            >
              {scan?.lastStatus === 'running' ? 'Scanning…' : 'Manual library scan'}
            </button>
            {libMsg && <span className="text-sm text-slate-400">{libMsg}</span>}
            {scan && scan.lastStatus !== 'never' && (
              <span className="text-xs text-slate-500">
                Scan: {scan.lastStatus}
                {scan.lastMessage ? ` — ${scan.lastMessage}` : ''}
              </span>
            )}
          </div>
        )}

        {/* Managed libraries + storage are derived from Plex, so they live inside
            the Plex section rather than as standalone connectors. */}
        <div className="mt-4 border-t border-slate-800 pt-3">
          <div className="mb-2 text-sm font-semibold text-slate-200">Managed libraries</div>
          {sections.length === 0 ? (
            <p className="text-sm text-slate-400">
              Connect Plex and run a library scan to discover your libraries.
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-400 mb-3">
                Choose which Plex libraries Keeparr tracks. Unticked ones drop on the next scan.
              </p>
              <div className="space-y-2">
                {sections.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={isManaged(s.id)}
                      onChange={(e) => toggleManaged(s.id, e.target.checked)}
                      className="h-4 w-4 accent-brand"
                    />
                    {s.title}
                    <span className="text-xs text-slate-600">({s.type})</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="mt-4 border-t border-slate-800 pt-3">
          <div className="mb-2 text-sm font-semibold text-slate-200">Storage / free space</div>
          {sections.length === 0 ? (
            <p className="text-sm text-slate-400">Discover libraries first.</p>
          ) : (
            <>
              <p className="text-sm text-slate-400 mb-3">
                Map each library to the path where its files live{' '}
                <strong>inside the Keeparr container</strong> (mount your media share
                read-only). Powers the free-space header.
              </p>
              <div className="space-y-3">
                {sections.map((s) => (
                  <div key={s.id}>
                    <label className="block text-sm text-slate-400 mb-1">
                      {s.title}
                      {s.paths && s.paths.length > 0 && (
                        <span className="text-slate-600"> — Plex: {s.paths.join(', ')}</span>
                      )}
                    </label>
                    <div className="flex gap-2">
                      <input
                        className={`${inputCls} flex-1`}
                        placeholder="/media/…"
                        value={storagePaths[s.id] ?? ''}
                        onChange={(e) =>
                          setStoragePaths((p) => ({ ...p, [s.id]: e.target.value }))
                        }
                      />
                      <button onClick={() => checkPath(s.id)} className={btnGhost} type="button">
                        Check
                      </button>
                    </div>
                    {storageMsg[s.id] && (
                      <p className="mt-1 text-xs text-slate-400">{storageMsg[s.id]}</p>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Card>

      {/* Tautulli is the Plex watch-history source. Jellyfin/Emby have native
          watch data, so the card is hidden for them. */}
      {serverType === 'plex' && (
        <Card title="Tautulli (watch history)">
          <ServiceFields parts={taut} setParts={setTaut} showBase />
          <label className="block text-sm text-slate-400 mt-3 mb-1">
            API key {tautConfigured && '(saved — leave blank to keep)'}
          </label>
          <input
            className={`${inputCls} max-w-md`}
            type="password"
            value={tautKey}
            onChange={(e) => setTautKey(e.target.value)}
          />
          <div className="mt-3 flex items-center gap-3">
            <button onClick={() => testConn('tautulli')} className={btnGhost} type="button">
              Test
            </button>
            {test.tautulli && <span className="text-sm text-slate-400">{test.tautulli}</span>}
          </div>
        </Card>
      )}

      <Card title="Overseerr / Seerr (requests)">
        <ServiceFields parts={seerr} setParts={setSeerr} showBase />
        <label className="block text-sm text-slate-400 mt-3 mb-1">
          API key {seerrConfigured && '(saved — leave blank to keep)'}
        </label>
        <input
          className={`${inputCls} max-w-md`}
          type="password"
          value={seerrKey}
          onChange={(e) => setSeerrKey(e.target.value)}
        />
        <div className="mt-3 flex items-center gap-3">
          <button onClick={() => testConn('seerr')} className={btnGhost} type="button">
            Test
          </button>
          {test.seerr && <span className="text-sm text-slate-400">{test.seerr}</span>}
        </div>
      </Card>

      <ArrCard
        title="Sonarr (TV quality + tags)"
        kind="sonarr"
        rows={sonarr}
        setRows={setSonarr}
        test={test}
        onTest={(idx) => testArrInstance('sonarr', idx)}
      />

      <ArrCard
        title="Radarr (movie quality + tags)"
        kind="radarr"
        rows={radarr}
        setRows={setRadarr}
        test={test}
        onTest={(idx) => testArrInstance('radarr', idx)}
      />

      {(sonarr.length > 0 || radarr.length > 0) && <MatchHealthCard />}

      </CardColumns>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className={btnCls}>
          {saving ? 'Saving…' : 'Save connections'}
        </button>
        {msg && <span className="text-sm text-slate-300">{msg}</span>}
      </div>
    </div>
  );
}
