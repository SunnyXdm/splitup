import { Hono } from 'hono';
import { requireAuth, type AppEnv } from '../auth';
import { db, type UserRow } from '../db';
import { meBody } from '../validate';
import { readJson, toMe } from '../lib/wire';

const app = new Hono<AppEnv>();
app.use(requireAuth);

app.patch('/', async (c) => {
  const me = c.get('user');
  const body = meBody.parse(await readJson(c));
  db.prepare(
    'UPDATE users SET name = COALESCE(?, name), default_currency = COALESCE(?, default_currency) WHERE id = ?',
  ).run(body.name ?? null, body.defaultCurrency ?? null, me.id);
  const updated = db.prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?').get(me.id)!;
  return c.json(toMe(updated));
});

export default app;
