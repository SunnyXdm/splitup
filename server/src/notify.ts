import webpush, { WebPushError } from 'web-push';
import { APP_ORIGIN } from './auth';
import { db } from './db';
import type { PushPayload } from './lib/push-payload';

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const getSetting = db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?');
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');

/**
 * VAPID keys: the env pair wins when both are set; otherwise a pair generated
 * on first boot and persisted in `settings`, so restarts keep the same keys
 * (a new key would orphan every existing browser subscription).
 */
function loadVapidKeys(): VapidKeys {
  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate };
  if (envPublic || envPrivate) {
    console.warn('push: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together; using stored keys');
  }
  const stored = () => {
    const pub = getSetting.get('vapid_public_key')?.value;
    const priv = getSetting.get('vapid_private_key')?.value;
    return pub && priv ? { publicKey: pub, privateKey: priv } : null;
  };
  const existing = stored();
  if (existing) return existing;
  const fresh = webpush.generateVAPIDKeys();
  db.transaction(() => {
    insertSetting.run('vapid_public_key', fresh.publicKey);
    insertSetting.run('vapid_private_key', fresh.privateKey);
  })();
  return stored() ?? fresh;
}

/** mailto:/https: subject; Apple rejects localhost, so dev falls back to a mailto. */
function vapidSubject(): string {
  const env = process.env.VAPID_SUBJECT?.trim();
  if (env) return env;
  const origin = new URL(APP_ORIGIN);
  if (origin.protocol === 'https:' && origin.hostname !== 'localhost') return origin.origin;
  return 'mailto:push@splitup.invalid';
}

const keys = loadVapidKeys();
webpush.setVapidDetails(vapidSubject(), keys.publicKey, keys.privateKey);

export const vapidPublicKey = keys.publicKey;

interface SubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

const deleteSub = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');

/** Host of the push service only — endpoints are capability URLs, never log them whole. */
const endpointHost = (endpoint: string) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid';
  }
};

async function sendOne(sub: SubscriptionRow, body: string): Promise<void> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      body,
      { TTL: 24 * 60 * 60, urgency: 'normal', timeout: 10_000 },
    );
  } catch (err) {
    if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
      // Subscription expired or revoked by the browser: forget it.
      try {
        deleteSub.run(sub.id);
      } catch {
        // db closing during shutdown — next send retries the cleanup
      }
      return;
    }
    const status = err instanceof WebPushError ? err.statusCode : undefined;
    const message = err instanceof Error ? err.message.slice(0, 120) : 'unknown error';
    console.warn(`push: send failed (${endpointHost(sub.endpoint)} ${status ?? '-'}): ${message}`);
  }
}

export type PayloadFor = PushPayload | ((userId: number) => PushPayload | null);

/**
 * Fire-and-forget: deliver `payload` to every subscribed device of each user.
 * Call AFTER the transaction commits. Never throws and never blocks the
 * response — work is deferred to the next macrotask and all errors are caught.
 */
export function notifyUsers(userIds: Iterable<number>, payload: PayloadFor): void {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  setImmediate(() => {
    try {
      const subsOf = db.prepare<[number], SubscriptionRow>(
        'SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
      );
      // Guests can't sign in (so can't subscribe); skip them explicitly anyway.
      const isGuest = db.prepare<[number], { is_guest: number }>(
        'SELECT is_guest FROM users WHERE id = ?',
      );
      const sends: Promise<void>[] = [];
      for (const uid of ids) {
        if (isGuest.get(uid)?.is_guest) continue;
        const subs = subsOf.all(uid);
        if (subs.length === 0) continue;
        const p = typeof payload === 'function' ? payload(uid) : payload;
        if (!p) continue;
        const body = JSON.stringify(p);
        for (const sub of subs) sends.push(sendOne(sub, body));
      }
      void Promise.allSettled(sends);
    } catch (err) {
      console.warn('push: notify failed:', err instanceof Error ? err.message : 'unknown error');
    }
  });
}
