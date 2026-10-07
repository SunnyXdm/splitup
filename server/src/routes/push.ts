import { Hono } from 'hono';
import { requireAuth, type AppEnv } from '../auth';
import { db, nowIso } from '../db';
import { readJson } from '../lib/wire';
import { vapidPublicKey } from '../notify';
import { pushSubscriptionBody, pushUnsubscribeBody } from '../validate';

/** Devices per user; the oldest subscription is dropped past this. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

const app = new Hono<AppEnv>();
app.use(requireAuth);

app.get('/key', (c) => c.json({ publicKey: vapidPublicKey }));

/**
 * Upsert by endpoint. An endpoint identifies one browser install, so a
 * re-subscribe after switching accounts on the same device re-binds it to the
 * current user (the previous owner stops receiving there).
 */
app.post('/subscriptions', async (c) => {
  const me = c.get('user');
  const body = pushSubscriptionBody.parse(await readJson(c));
  db.transaction(() => {
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         created_at = excluded.created_at`,
    ).run(me.id, body.endpoint, body.keys.p256dh, body.keys.auth, nowIso());
    db.prepare(
      `DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
         SELECT id FROM push_subscriptions WHERE user_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?
       )`,
    ).run(me.id, me.id, MAX_SUBSCRIPTIONS_PER_USER);
  })();
  return c.body(null, 204);
});

/** Removes this device's subscription; only the owner's row, unknown → still 204. */
app.delete('/subscriptions', async (c) => {
  const me = c.get('user');
  const { endpoint } = pushUnsubscribeBody.parse(await readJson(c));
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(
    endpoint,
    me.id,
  );
  return c.body(null, 204);
});

export default app;
