import { randomUUID } from 'node:crypto';
import { getSetting, setSetting } from './queries';
import { decryptSecret, encryptSecret } from './crypto';
import {
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_JOB_SCHEDULES,
  type JobSchedule,
} from './config';

/**
 * Typed accessors over the settings key/value table. Token fields are encrypted
 * at rest. Keep all setting keys defined here so callers never use raw strings.
 */

// Keys whose values are secrets (encrypted before storage).
const SECRET_KEYS = new Set([
  'plex_admin_token',
  'plex_server_token',
  // Jellyfin / Emby access tokens (mirror the Plex token keys per backend).
  'jellyfin_token',
  'jellyfin_admin_token',
  'emby_token',
  'emby_admin_token',
  'tautulli_api_key',
  'seerr_api_key',
  'api_key',
  // Whole JSON blob encrypted at rest (each instance holds an apiKey).
  'sonarr_instances',
  'radarr_instances',
  // FORK: the Discord webhook URL embeds its token — secret.
  'discord_webhook_url',
  // FORK: OMDb API key (ratings enrichment).
  'omdb_api_key',
]);

export function readSetting(key: string): string | null {
  const raw = getSetting(key);
  if (raw == null) return null;
  return SECRET_KEYS.has(key) ? decryptSecret(raw) : raw;
}

export function writeSetting(key: string, value: string): void {
  setSetting(key, SECRET_KEYS.has(key) ? encryptSecret(value) : value);
}

// --- Media server (Plex / Jellyfin / Emby) ---
// Keeparr targets ONE media server at a time, chosen at setup (like Seerr's
// `mediaServerType`). Existing installs predate this key, so it defaults to
// 'plex' — a Plex deployment keeps reading its `plex_*` keys with no migration.
export type MediaServerType = 'plex' | 'jellyfin' | 'emby';

export function getMediaServerType(): MediaServerType {
  const v = readSetting('media_server_type');
  return v === 'jellyfin' || v === 'emby' ? v : 'plex';
}

export function setMediaServerType(type: MediaServerType): void {
  writeSetting('media_server_type', type);
}

// Per-backend settings-key map. Plex keeps its historical key names (so nothing
// changes for existing installs); Jellyfin/Emby use a uniform `<type>_*` scheme.
export type ServerField = 'url' | 'token' | 'id' | 'name' | 'ownerId' | 'adminToken';
const SERVER_KEYS: Record<MediaServerType, Record<ServerField, string>> = {
  plex: {
    url: 'plex_base_url',
    token: 'plex_server_token',
    id: 'plex_machine_id',
    name: 'plex_server_name',
    ownerId: 'plex_owner_id',
    adminToken: 'plex_admin_token',
  },
  jellyfin: {
    url: 'jellyfin_url',
    token: 'jellyfin_token',
    id: 'jellyfin_server_id',
    name: 'jellyfin_server_name',
    ownerId: 'jellyfin_owner_id',
    adminToken: 'jellyfin_admin_token',
  },
  emby: {
    url: 'emby_url',
    token: 'emby_token',
    id: 'emby_server_id',
    name: 'emby_server_name',
    ownerId: 'emby_owner_id',
    adminToken: 'emby_admin_token',
  },
};
const skey = (field: ServerField) => SERVER_KEYS[getMediaServerType()][field];

/** Write a backend connection field by logical name (keeps key names centralized). */
export function setServerField(
  type: MediaServerType,
  field: ServerField,
  value: string
): void {
  writeSetting(SERVER_KEYS[type][field], value);
}

// Generic, backend-aware accessors. For 'plex' (the default) these resolve to the
// exact same keys/values as before, so Plex behavior is unchanged.
export const getServerBaseUrl = () => readSetting(skey('url'));
export const getServerToken = () => readSetting(skey('token'));
export const getServerId = () => readSetting(skey('id'));
export const getServerName = () => readSetting(skey('name'));
export const getOwnerId = () => readSetting(skey('ownerId'));
export const getAdminToken = () => readSetting(skey('adminToken'));

// Plex-specific aliases kept for the Plex-only code paths (discovery, identity).
export const getMachineId = () => readSetting('plex_machine_id');
export const getPlexBaseUrl = () => readSetting('plex_base_url');

/** True once an admin has connected a media server (per the configured type). */
export function isServerConfigured(): boolean {
  if (getMediaServerType() === 'plex') {
    return !!getMachineId() && !!getPlexBaseUrl() && !!getServerToken();
  }
  // Jellyfin/Emby: a base URL + access token is enough to read the server.
  return !!getServerBaseUrl() && !!getServerToken();
}

// --- Tautulli ---
export const getTautulliUrl = () => readSetting('tautulli_url');
export const getTautulliKey = () => readSetting('tautulli_api_key');
export const isTautulliConfigured = () =>
  !!getTautulliUrl() && !!getTautulliKey();

/**
 * Whether watch data is available for the configured backend (drives the Watched
 * filter, the watched badge, and the Big Picture never-watched metric): Plex needs
 * Tautulli; Jellyfin/Emby have native watch data once connected.
 */
export const isWatchAvailable = () =>
  getMediaServerType() === 'plex' ? isTautulliConfigured() : isServerConfigured();

// --- Seerr ---
export const getSeerrUrl = () => readSetting('seerr_url');
export const getSeerrKey = () => readSetting('seerr_api_key');
export const isSeerrConfigured = () => !!getSeerrUrl() && !!getSeerrKey();

// --- Sonarr / Radarr (N instances each; stored as an encrypted JSON array) ---
export interface ArrInstance {
  id: string;
  name: string;
  url: string;
  apiKey: string;
}

function readArrInstances(key: string): ArrInstance[] {
  const raw = readSetting(key);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((i) => i && typeof i.url === 'string')
      .map((i) => ({
        id: String(i.id ?? i.url),
        name: String(i.name ?? '').trim(),
        url: String(i.url).trim().replace(/\/$/, ''),
        apiKey: String(i.apiKey ?? ''),
      }));
  } catch {
    return [];
  }
}

export const getSonarrInstances = () => readArrInstances('sonarr_instances');
export const getRadarrInstances = () => readArrInstances('radarr_instances');

export function setSonarrInstances(instances: ArrInstance[]): void {
  writeSetting('sonarr_instances', JSON.stringify(instances));
}
export function setRadarrInstances(instances: ArrInstance[]): void {
  writeSetting('radarr_instances', JSON.stringify(instances));
}

/** True once at least one Sonarr or Radarr instance is configured. */
export const isArrConfigured = () =>
  getSonarrInstances().length > 0 || getRadarrInstances().length > 0;

// --- Stable per-install client/device ids (generated once, then persisted) ---

/** Stable X-Plex-Client-Identifier for the plex.tv PIN flow. */
export function getPlexClientId(): string {
  return getOrCreateId('plex_client_id');
}

/** Stable device id for the Jellyfin/Emby MediaBrowser auth header. */
export function getMediaDeviceId(): string {
  return getOrCreateId('media_device_id');
}

function getOrCreateId(key: string): string {
  let id = readSetting(key);
  if (!id) {
    id = randomUUID();
    writeSetting(key, id);
  }
  return id;
}

// --- Scheduled job schedules (per job: interval minutes or daily HH:MM) ---
export type { JobSchedule };

export function getJobSchedules(): Record<string, JobSchedule> {
  const out: Record<string, JobSchedule> = { ...DEFAULT_JOB_SCHEDULES };
  const raw = readSetting('job_schedules');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, JobSchedule>;
      for (const [k, v] of Object.entries(parsed)) {
        if (v && (v.type === 'interval' || v.type === 'daily' || v.type === 'weekly')) {
          out[k] = v;
        }
      }
    } catch {
      /* fall back to defaults */
    }
  }
  return out;
}

export function setJobSchedules(schedules: Record<string, JobSchedule>): void {
  writeSetting('job_schedules', JSON.stringify({ ...getJobSchedules(), ...schedules }));
}

// --- Public app URL (Plex auth forwardUrl); overrides the APP_URL env var ---
export const getAppUrl = () => readSetting('app_url') ?? '';
export const setAppUrl = (url: string) => writeSetting('app_url', url.trim());

// --- Plex sections (captured during sync; drives the library lists + storage) ---
export interface StoredSection {
  id: string;
  title: string;
  type: string;
  /** On-disk folder(s) Plex reports for this library (server-side paths). */
  paths?: string[];
}

export function getPlexSections(): StoredSection[] {
  const raw = readSetting('plex_sections');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Back-compat: older rows lack `paths`.
    return (arr as StoredSection[]).map((s) => ({ paths: [], ...s }));
  } catch {
    return [];
  }
}

// --- Storage mappings (section id -> container path to measure free space) ---
export interface StoredStorageMapping {
  sectionId: string;
  path: string;
}

export function getStorageMappings(): StoredStorageMapping[] {
  const raw = readSetting('storage_mappings');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as StoredStorageMapping[]) : [];
  } catch {
    return [];
  }
}

export function setStorageMappings(mappings: StoredStorageMapping[]): void {
  writeSetting('storage_mappings', JSON.stringify(mappings));
}

export function setPlexSections(sections: StoredSection[]): void {
  writeSetting('plex_sections', JSON.stringify(sections));
}

// --- Managed libraries (which Plex sections Keeparr tracks; empty = all) ---
export function getManagedSectionIds(): string[] {
  const raw = readSetting('managed_section_ids');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

export function setManagedSectionIds(ids: string[]): void {
  writeSetting('managed_section_ids', JSON.stringify(ids));
}

/** Discovered sections, filtered to the managed set (all when none chosen). */
export function getManagedSections(): StoredSection[] {
  const managed = new Set(getManagedSectionIds());
  const all = getPlexSections();
  return managed.size === 0 ? all : all.filter((s) => managed.has(s.id));
}

// --- Access control ---
/** Whether any Plex user with server access may sign in (vs only enabled users). */
export function getOpenSignin(): boolean {
  return readSetting('open_signin') !== 'false'; // default: open
}

export function setOpenSignin(open: boolean): void {
  writeSetting('open_signin', open ? 'true' : 'false');
}

// --- API key (for external automation; encrypted at rest) ---
export const getApiKey = () => readSetting('api_key');
export const setApiKey = (key: string) => writeSetting('api_key', key);
export const isApiKeyConfigured = () => !!getApiKey();

// --- Backups ---
/** How many backup files to keep (oldest pruned first). */
export function getBackupRetention(): number {
  const n = Number(readSetting('backup_retention'));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BACKUP_RETENTION;
}

export function setBackupRetention(n: number): void {
  writeSetting('backup_retention', String(Math.max(1, Math.floor(n))));
}

// --- FORK: scheduled deletions (default OFF; dry-run defaults ON) ---
/** Master switch for the purge job. Nothing is ever deleted while this is off. */
export function getDeletionEnabled(): boolean {
  return readSetting('deletion_enabled') === 'true'; // default: OFF
}
export function setDeletionEnabled(on: boolean): void {
  writeSetting('deletion_enabled', on ? 'true' : 'false');
}

/** Days between tagging an item and it becoming purge-eligible. */
export function getDeletionGraceDays(): number {
  const n = Number(readSetting('deletion_grace_days'));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
}
export function setDeletionGraceDays(n: number): void {
  writeSetting('deletion_grace_days', String(Math.max(0, Math.floor(n))));
}

/** Dry run: the purge job only LOGS what it would delete. Defaults ON. */
export function getDeletionDryRun(): boolean {
  return readSetting('deletion_dry_run') !== 'false'; // default: ON
}
export function setDeletionDryRun(on: boolean): void {
  writeSetting('deletion_dry_run', on ? 'true' : 'false');
}

/** Mirror pending tags into a "Leaving Soon" Jellyfin/Emby collection. */
export function getLeavingSoonEnabled(): boolean {
  return readSetting('leaving_soon_enabled') !== 'false'; // default: ON (inert without the master toggle)
}
export function setLeavingSoonEnabled(on: boolean): void {
  writeSetting('leaving_soon_enabled', on ? 'true' : 'false');
}

/** Cached "Leaving Soon" collection id (revalidated each sync). */
export const getLeavingSoonCollectionId = () => readSetting('leaving_soon_collection_id');
export const setLeavingSoonCollectionId = (id: string) =>
  writeSetting('leaving_soon_collection_id', id);

/** Discord webhook for deletion notifications (empty = notifications off). */
export const getDiscordWebhookUrl = () => readSetting('discord_webhook_url');
export const setDiscordWebhookUrl = (url: string) =>
  writeSetting('discord_webhook_url', url.trim());
export const isDiscordConfigured = () => !!getDiscordWebhookUrl();

// --- FORK: OMDb (IMDb/RT/Metacritic ratings for swipe cards) ---
export const getOmdbKey = () => readSetting('omdb_api_key');
export const setOmdbKey = (key: string) => writeSetting('omdb_api_key', key.trim());
export const isOmdbConfigured = () => !!getOmdbKey();

// --- Local demo (set only by the dev seed; synthetic storage capacity) ---
export function getDevStorageTotal(): number | null {
  const v = Number(readSetting('dev_storage_total'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

// --- Branding ---
export function getAppTitle(): string {
  const t = readSetting('app_title');
  return t && t.trim() ? t.trim() : 'Keeparr';
}

export function setAppTitle(title: string): void {
  writeSetting('app_title', title.trim());
}
