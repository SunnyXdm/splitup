import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { db, nowIso, type UserRow } from './db';

export const APP_ORIGIN = new URL(process.env.APP_ORIGIN ?? 'http://localhost:5173').origin;
const IS_PROD = process.env.NODE_ENV === 'production';

const SHOO_ISSUER = 'https://shoo.dev';
const jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', SHOO_ISSUER));

export type AppEnv = { Variables: { user: UserRow } };

export interface ShooClaims extends JWTPayload {
  pairwise_sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export async function verifyShooToken(idToken: string): Promise<ShooClaims> {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: SHOO_ISSUER,
    audience: `origin:${APP_ORIGIN}`,
    algorithms: ['ES256'],
  });
  if (typeof payload.pairwise_sub !== 'string' || payload.pairwise_sub.length === 0) {
    throw new HTTPException(401, { message: 'invalid token' });
  }
  return payload as ShooClaims;
}

export function upsertUserFromClaims(claims: ShooClaims): UserRow {
  const existing = db
    .prepare<[string], UserRow>('SELECT * FROM users WHERE shoo_sub = ?')
    .get(claims.pairwise_sub);
  const email = claims.email_verified ? (claims.email?.toLowerCase() ?? null) : null;
  const picture = claims.picture ?? null;
  if (existing) {
    db.prepare(
      `UPDATE users SET
         email = COALESCE(?, email),
         name = COALESCE(?, name),
         picture = COALESCE(?, picture)
       WHERE id = ?`,
    ).run(email, claims.name ?? null, picture, existing.id);
  } else {
    const name = claims.name ?? claims.email?.split('@')[0] ?? 'Someone';
    db.prepare(
      "INSERT INTO users (shoo_sub, email, name, picture, default_currency, created_at) VALUES (?, ?, ?, ?, 'INR', ?)",
    ).run(claims.pairwise_sub, email, name, picture, nowIso());
  }
  return db
    .prepare<[string], UserRow>('SELECT * FROM users WHERE shoo_sub = ?')
    .get(claims.pairwise_sub)!;
}

const COOKIE_NAME = 'splitup_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_BELOW_MS = 15 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(c: Context, userId: number): void {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    hashToken(token),
    userId,
    nowIso(),
    new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  );
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: IS_PROD,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

interface SessionRow {
  id: string;
  user_id: number;
  expires_at: string;
}

/** Returns the signed-in user for this request, or null. Renews sessions nearing expiry. */
export function sessionUser(c: Context): UserRow | null {
  const token = getCookie(c, COOKIE_NAME);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const id = hashToken(token);
  const session = db
    .prepare<[string], SessionRow>('SELECT id, user_id, expires_at FROM sessions WHERE id = ?')
    .get(id);
  if (!session) return null;
  const expiresAt = Date.parse(session.expires_at);
  if (!(expiresAt > Date.now())) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return null;
  }
  if (expiresAt - Date.now() < RENEW_BELOW_MS) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      id,
    );
    // Re-issue the cookie too — renewing only the DB row would let the
    // browser cookie hard-expire 30 days after sign-in even for active users.
    setCookie(c, COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: IS_PROD,
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
  }
  return db.prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?').get(session.user_id) ?? null;
}

export function destroySession(c: Context): void {
  const token = getCookie(c, COOKIE_NAME);
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const user = sessionUser(c);
  if (!user) throw new HTTPException(401, { message: 'unauthorized' });
  c.set('user', user);
  await next();
});

/** Occasionally purge expired sessions and invites. */
export function pruneExpired(): void {
  const now = nowIso();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM group_invites WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM friend_invites WHERE expires_at < ?').run(now);
}
