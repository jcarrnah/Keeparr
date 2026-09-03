import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { __setTestDbToMemory, __closeDb } from './db';
import {
  getMediaServerType,
  setMediaServerType,
  getServerBaseUrl,
  getServerToken,
  getServerName,
  getOwnerId,
  isServerConfigured,
  isWatchAvailable,
  writeSetting,
} from './settings';

beforeEach(() => {
  __setTestDbToMemory();
});
afterAll(() => {
  __closeDb();
});

describe('media server type + backend-aware settings', () => {
  it('defaults to plex when unset (backward compat for existing installs)', () => {
    expect(getMediaServerType()).toBe('plex');
  });

  it('an existing Plex install (plex_* keys set, no media_server_type) works unchanged', () => {
    writeSetting('plex_machine_id', 'abc');
    writeSetting('plex_base_url', 'http://plex:32400');
    writeSetting('plex_server_token', 'tok-plex');
    expect(getMediaServerType()).toBe('plex');
    expect(isServerConfigured()).toBe(true);
    expect(getServerBaseUrl()).toBe('http://plex:32400');
    expect(getServerToken()).toBe('tok-plex'); // decrypted round-trip
  });

  it('resolves generic accessors to the configured backend, isolated per type', () => {
    // Plex configured...
    writeSetting('plex_machine_id', 'abc');
    writeSetting('plex_base_url', 'http://plex:32400');
    writeSetting('plex_server_token', 'tok-plex');
    writeSetting('plex_owner_id', '111');

    // ...switch to Jellyfin: not configured until its own keys exist.
    setMediaServerType('jellyfin');
    expect(getMediaServerType()).toBe('jellyfin');
    expect(isServerConfigured()).toBe(false);
    expect(getServerToken()).toBeNull();

    writeSetting('jellyfin_url', 'http://jf:8096');
    writeSetting('jellyfin_token', 'tok-jf');
    writeSetting('jellyfin_server_name', 'My Jellyfin');
    writeSetting('jellyfin_owner_id', '222');
    expect(isServerConfigured()).toBe(true);
    expect(getServerBaseUrl()).toBe('http://jf:8096');
    expect(getServerToken()).toBe('tok-jf');
    expect(getServerName()).toBe('My Jellyfin');
    expect(getOwnerId()).toBe('222');

    // Flipping back to Plex reveals the untouched Plex config.
    setMediaServerType('plex');
    expect(isServerConfigured()).toBe(true);
    expect(getServerToken()).toBe('tok-plex');
    expect(getOwnerId()).toBe('111');
  });
});

describe('isWatchAvailable (any watch source, not just Tautulli)', () => {
  const connectPlex = () => {
    writeSetting('plex_machine_id', 'm1');
    writeSetting('plex_base_url', 'http://plex:32400');
    writeSetting('plex_server_token', 'tok');
  };

  it('is false with nothing connected', () => {
    expect(isWatchAvailable()).toBe(false);
  });

  it('is true for a Plex server with no Tautulli - Plex has its own history', () => {
    connectPlex();
    expect(isWatchAvailable()).toBe(true);
  });

  it('is true for Tautulli alone, before a server is connected', () => {
    writeSetting('tautulli_url', 'http://taut');
    writeSetting('tautulli_api_key', 'k');
    expect(isWatchAvailable()).toBe(true);
  });
});
