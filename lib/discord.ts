/**
 * FORK: Discord webhook notifications for the scheduled-deletion pipeline.
 * Events: item tagged (manual + rules), items entering their final 7 days,
 * purge summary (what was deleted + GB reclaimed), purge failures. No-op —
 * never throws — while no webhook URL is configured; a failed send is logged
 * and swallowed so notifications can never break a job.
 */
import { fetchJson } from './http';
import { logEvent } from './queries';
import { getDiscordWebhookUrl } from './settings';

/** POST a plain-content message to the configured webhook. True if sent. */
export async function sendDiscordMessage(content: string): Promise<boolean> {
  const url = getDiscordWebhookUrl();
  if (!url) return false;
  try {
    await fetchJson<unknown>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900) }), // Discord caps at 2000
      label: 'Discord webhook',
      allowEmpty: true, // 204 No Content on success
    });
    return true;
  } catch (e) {
    logEvent('warn', 'discord', `Notification failed: ${String(e)}`);
    return false;
  }
}

/** Send a test message (the Settings Test button). Never throws. */
export async function testDiscord(url: string): Promise<{ ok: boolean; message: string }> {
  try {
    await fetchJson<unknown>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '👋 Keeparr test notification — the webhook works.' }),
      label: 'Discord webhook',
      allowEmpty: true,
    });
    return { ok: true, message: 'Test message sent.' };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}
