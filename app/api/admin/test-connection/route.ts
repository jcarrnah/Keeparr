import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { errorResponse } from '@/lib/route-helpers';
import { getServerIdentity } from '@/lib/plex';
import {
  getDiscordWebhookUrl,
  getOmdbKey,
  getRadarrInstances,
  getSeerrKey,
  getServerToken,
  getSonarrInstances,
  getTautulliKey,
} from '@/lib/settings';
import { testDiscord } from '@/lib/discord';
import { testOmdb } from '@/lib/omdb';
import { logEvent } from '@/lib/queries';
import { testTautulli } from '@/lib/tautulli';
import { testSeerr } from '@/lib/seerr';
import { testArr } from '@/lib/arr';
import { testJellyfin } from '@/lib/jellyfin';

export const runtime = 'nodejs';

interface Body {
  service:
    | 'plex'
    | 'jellyfin'
    | 'emby'
    | 'tautulli'
    | 'seerr'
    | 'sonarr'
    | 'radarr'
    | 'discord' // FORK: deletion-notification webhook
    | 'omdb'; // FORK: ratings enrichment
  url: string;
  apiKey?: string;
  token?: string;
  /** For re-testing a saved Sonarr/Radarr instance without re-typing its key. */
  instanceId?: string;
}

/** Probe a service's reachability with the provided (unsaved) credentials. The
 *  result is also written to the app log (Settings → Logs) so failures are
 *  diagnosable without server console access. */
export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = (await req.json()) as Body;

    let result: { ok: boolean; message: string };
    if (body.service === 'plex') {
      try {
        // Fall back to the saved server token (e.g. when re-testing a manual URL).
        const token = body.token || getServerToken() || '';
        const id = await getServerIdentity(body.url, token);
        result = { ok: true, message: `Reached ${id.friendlyName}` };
      } catch (e) {
        result = { ok: false, message: String(e) };
      }
    } else if (body.service === 'jellyfin' || body.service === 'emby') {
      result = await testJellyfin(body.url);
    } else if (body.service === 'tautulli') {
      // Blank key → fall back to the saved one (re-testing a saved connection).
      result = await testTautulli(body.url, body.apiKey || getTautulliKey() || '');
    } else if (body.service === 'seerr') {
      result = await testSeerr(body.url, body.apiKey || getSeerrKey() || '');
    } else if (body.service === 'sonarr' || body.service === 'radarr') {
      // Blank key + a saved instance id → use that instance's stored key.
      let key = body.apiKey ?? '';
      if (!key && body.instanceId) {
        const insts =
          body.service === 'sonarr' ? getSonarrInstances() : getRadarrInstances();
        key = insts.find((i) => i.id === body.instanceId)?.apiKey ?? '';
      }
      result = await testArr(body.url, key);
    } else if (body.service === 'discord') {
      // FORK: blank url → fall back to the saved webhook (re-testing).
      result = await testDiscord(body.url || getDiscordWebhookUrl() || '');
    } else if (body.service === 'omdb') {
      // FORK: blank key → fall back to the saved one (re-testing).
      result = await testOmdb(body.apiKey || getOmdbKey() || '');
    } else {
      return NextResponse.json({ error: 'bad_service' }, { status: 400 });
    }

    logEvent(
      result.ok ? 'info' : 'warn',
      'connection',
      `Test ${body.service} (${body.url}): ${result.ok ? 'OK' : 'failed'} — ${result.message}`
    );
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
