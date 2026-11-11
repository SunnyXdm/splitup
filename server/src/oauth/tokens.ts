import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import { db, nowIso, type OAuthGrantRow, type PersonalAccessTokenRow, type UserRow } from '../db';
import { isGuestSub } from '../auth';
import { ACCESS_TTL_MS, MCP_RESOURCE, REFRESH_TTL_MS, parseScopes, type Scope } from './config';

/** Every secret is stored as its SHA-256; the plaintext exists only in transit. */
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** An opaque secret: a type prefix + 256 random bits, base64url. */
export const newSecret = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;

export const PAT_PREFIX = 'spu_';
export const ACCESS_PREFIX = 'spa_';
export const REFRESH_PREFIX = 'spr_';
export const CODE_PREFIX = 'spc_';

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Who a verified bearer token acts for; carried in AuthInfo.extra. */
export interface TokenPrincipal {
  userId: number;
  /** Shown in activity ("via Claude") and in Connected apps. */
  clientName: string;
  kind: 'oauth' | 'pat';
  /** oauth_grants.id or personal_access_tokens.id. */
  credentialId: number;
}

export const principalOf = (auth: AuthInfo): TokenPrincipal =>
  auth.extra as unknown as TokenPrincipal;

// last_used_at is for the Connected apps list; once a minute is plenty and
// keeps a busy assistant from turning every read into a write.
const TOUCH_EVERY_MS = 60_000;
const stale = (iso: string | null) => !iso || Date.now() - Date.parse(iso) > TOUCH_EVERY_MS;

function liveUser(userId: number): UserRow | null {
  const user = db.prepare<[number], UserRow>('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.is_guest !== 0 || isGuestSub(user.shoo_sub)) return null;
  return user;
}

const invalid = (message = 'invalid or expired token') =>
  new OAuthError(OAuthErrorCode.InvalidToken, message);

/**
 * Bearer token → AuthInfo, for OAuth access tokens and personal access
 * tokens alike. Unknown, expired, revoked or guest-owned → invalid_token.
 */
export async function verifyAccessToken(token: string): Promise<AuthInfo> {
  if (token.startsWith(PAT_PREFIX)) {
    const row = db
      .prepare<[string], PersonalAccessTokenRow>(
        'SELECT * FROM personal_access_tokens WHERE token_hash = ? AND revoked_at IS NULL',
      )
      .get(sha256(token));
    if (!row || !liveUser(row.user_id)) throw invalid();
    if (stale(row.last_used_at)) {
      db.prepare('UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?').run(
        nowIso(),
        row.id,
      );
    }
    const principal: TokenPrincipal = {
      userId: row.user_id,
      clientName: row.name,
      kind: 'pat',
      credentialId: row.id,
    };
    return {
      token,
      clientId: `pat:${row.id}`,
      scopes: parseScopes(row.scope),
      // PATs live until revoked; the SDK wants an expiry, so report a rolling one.
      expiresAt: Math.floor((Date.now() + ACCESS_TTL_MS) / 1000),
      resource: new URL(MCP_RESOURCE),
      extra: { ...principal },
    };
  }
  if (token.startsWith(ACCESS_PREFIX)) {
    const row = db
      .prepare<[string, string], OAuthGrantRow & { expires_at: string; client_name: string }>(
        `SELECT g.*, t.expires_at, c.name AS client_name
         FROM oauth_tokens t
         JOIN oauth_grants g ON g.id = t.grant_id AND g.revoked_at IS NULL
         JOIN oauth_clients c ON c.id = g.client_id
         WHERE t.id = ? AND t.kind = 'access' AND t.expires_at > ?`,
      )
      .get(sha256(token), nowIso());
    if (!row || !liveUser(row.user_id)) throw invalid();
    if (stale(row.last_used_at)) {
      db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
    }
    const principal: TokenPrincipal = {
      userId: row.user_id,
      clientName: row.client_name,
      kind: 'oauth',
      credentialId: row.id,
    };
    return {
      token,
      clientId: row.client_id,
      scopes: parseScopes(row.scope),
      expiresAt: Math.floor(Date.parse(row.expires_at) / 1000),
      resource: new URL(row.resource),
      extra: { ...principal },
    };
  }
  throw invalid();
}

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** A fresh access + refresh token pair for a grant (inside the caller's transaction). */
export function issueTokens(grant: OAuthGrantRow): IssuedTokens {
  const access = newSecret(ACCESS_PREFIX);
  const refresh = newSecret(REFRESH_PREFIX);
  const now = Date.now();
  const insert = db.prepare(
    'INSERT INTO oauth_tokens (id, grant_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(
    sha256(access),
    grant.id,
    'access',
    new Date(now).toISOString(),
    new Date(now + ACCESS_TTL_MS).toISOString(),
  );
  insert.run(
    sha256(refresh),
    grant.id,
    'refresh',
    new Date(now).toISOString(),
    new Date(now + REFRESH_TTL_MS).toISOString(),
  );
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
    scope: grant.scope,
  };
}

/** Revoking a grant disconnects the app: its tokens stop working at once. */
export function revokeGrant(grantId: number): void {
  db.transaction(() => {
    db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(
      nowIso(),
      grantId,
    );
    db.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?').run(grantId);
    db.prepare('DELETE FROM oauth_codes WHERE grant_id = ?').run(grantId);
  })();
}

export function createPersonalAccessToken(
  userId: number,
  name: string,
  scopes: Scope[],
): { token: string; row: PersonalAccessTokenRow } {
  const token = newSecret(PAT_PREFIX);
  const id = Number(
    db
      .prepare(
        `INSERT INTO personal_access_tokens (user_id, name, token_hash, hint, scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, name, sha256(token), token.slice(-4), scopes.join(' '), nowIso())
      .lastInsertRowid,
  );
  const row = db
    .prepare<[number], PersonalAccessTokenRow>('SELECT * FROM personal_access_tokens WHERE id = ?')
    .get(id)!;
  return { token, row };
}

/** Housekeeping with the session prune: expired tokens, codes and requests. */
export function pruneOAuth(): void {
  const now = nowIso();
  db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM oauth_requests WHERE expires_at < ?').run(now);
}
