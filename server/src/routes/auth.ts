import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  createSession,
  destroySession,
  sessionUser,
  upsertUserFromClaims,
  verifyShooToken,
  type AppEnv,
  type ShooClaims,
} from '../auth';
import { sessionBody } from '../validate';
import { readJson, toMe } from '../lib/wire';

const app = new Hono<AppEnv>();

app.post('/session', async (c) => {
  // Already signed in? Reuse the session — no new row, no token verification.
  const existing = sessionUser(c);
  if (existing) return c.json({ me: toMe(existing) });

  const { idToken } = sessionBody.parse(await readJson(c));
  let claims: ShooClaims;
  try {
    claims = await verifyShooToken(idToken);
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    throw new HTTPException(401, { message: 'invalid token' });
  }
  const user = upsertUserFromClaims(claims);
  createSession(c, user.id);
  return c.json({ me: toMe(user) });
});

// No requireAuth: signing out with an already-dead session should still succeed
// (destroySession is a no-op then) instead of stranding the client at 401.
app.delete('/session', (c) => {
  destroySession(c);
  return c.body(null, 204);
});

export default app;
