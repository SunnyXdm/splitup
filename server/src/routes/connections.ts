import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { requireAuth, type AppEnv } from '../auth';
import {
  db,
  nowIso,
  type OAuthClientRow,
  type OAuthRequestRow,
  type PersonalAccessTokenRow,
} from '../db';
import { idParam } from '../validate';
import { readJson } from '../lib/wire';
import {
  CODE_TTL_MS,
  MCP_RESOURCE,
  SCOPES,
  SCOPE_READ,
  SCOPE_WRITE,
  parseScopes,
} from '../oauth/config';
import { clientById, redirectWith } from '../oauth/routes';
import {
  CODE_PREFIX,
  createPersonalAccessToken,
  newSecret,
  revokeGrant,
  sha256,
} from '../oauth/tokens';

/**
 * Session (cookie) API behind the web app's MCP screens: the OAuth consent
 * page (/oauth/consent) and Account → Connected apps & MCP (OAuth grants and
 * personal access tokens). Mounted under /api, so CSRF rules apply.
 */

const NOT_FOUND = () => new HTTPException(404, { message: 'not found' });
const MAX_TOKENS = 20;

/** An authorization request that is still pending, by its (unhashed) id. */
function pendingRequestOr404(id: string): { request: OAuthRequestRow; client: OAuthClientRow } {
  if (!/^[0-9a-f]{48}$/.test(id)) throw NOT_FOUND();
  const request = db
    .prepare<[string, string], OAuthRequestRow>(
      'SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?',
    )
    .get(sha256(id), nowIso());
  const client = request ? clientById(request.client_id) : null;
  if (!request || !client) throw NOT_FOUND();
  return { request, client };
}

const scopeList = z.array(z.enum(SCOPES)).min(1).max(SCOPES.length);

export const oauthConsentRoutes = new Hono<AppEnv>();
oauthConsentRoutes.use(requireAuth);

oauthConsentRoutes.get('/requests/:id', (c) => {
  const { request, client } = pendingRequestOr404(c.req.param('id'));
  const redirect = new URL(request.redirect_uri);
  return c.json({
    client: {
      name: client.name,
      uri: client.client_uri,
      // Where the user's approval is sent: the host they should recognize.
      redirectHost: redirect.host,
      loopback: redirect.protocol === 'http:',
    },
    scopes: parseScopes(request.scope),
  });
});

const approveBody = z.strictObject({ scopes: scopeList.optional() });

oauthConsentRoutes.post('/requests/:id/approve', async (c) => {
  const me = c.get('user');
  const body = approveBody.parse(await readJson(c));
  const { request, client } = pendingRequestOr404(c.req.param('id'));
  const requested = parseScopes(request.scope);
  // The user may narrow (untick write), never widen, what the app asked for.
  const granted = parseScopes(
    (body.scopes ?? requested).filter((s) => requested.includes(s)).join(' ') || SCOPE_READ,
  );
  const code = newSecret(CODE_PREFIX);
  const now = nowIso();
  db.transaction(() => {
    const { changes } = db.prepare('DELETE FROM oauth_requests WHERE id = ?').run(request.id);
    if (changes === 0) throw NOT_FOUND();
    // Reconnecting the same app replaces its earlier grant: one entry per app.
    const previous = db
      .prepare<[string, number], { id: number }>(
        'SELECT id FROM oauth_grants WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL',
      )
      .all(client.id, me.id);
    for (const g of previous) revokeGrant(g.id);
    const grantId = Number(
      db
        .prepare(
          `INSERT INTO oauth_grants (client_id, user_id, scope, resource, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(client.id, me.id, granted.join(' '), request.resource, now).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO oauth_codes (id, grant_id, redirect_uri, code_challenge, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      sha256(code),
      grantId,
      request.redirect_uri,
      request.code_challenge,
      new Date(Date.now() + CODE_TTL_MS).toISOString(),
    );
  })();
  return c.json({ redirectTo: redirectWith(request.redirect_uri, { code, state: request.state }) });
});

oauthConsentRoutes.post('/requests/:id/deny', (c) => {
  const { request } = pendingRequestOr404(c.req.param('id'));
  db.prepare('DELETE FROM oauth_requests WHERE id = ?').run(request.id);
  return c.json({
    redirectTo: redirectWith(request.redirect_uri, {
      error: 'access_denied',
      error_description: 'The user declined access',
      state: request.state,
    }),
  });
});

// ------------------------------------------------------------ connected apps

const toToken = (r: PersonalAccessTokenRow) => ({
  id: r.id,
  name: r.name,
  hint: r.hint,
  scopes: parseScopes(r.scope),
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

export const connectionRoutes = new Hono<AppEnv>();
connectionRoutes.use(requireAuth);

connectionRoutes.get('/', (c) => {
  const me = c.get('user');
  // Apps with at least one live token: a consent whose code was never
  // exchanged, or whose refresh token lapsed, is not a connection.
  const apps = db
    .prepare<
      [number, string],
      {
        id: number;
        scope: string;
        created_at: string;
        last_used_at: string | null;
        name: string;
        client_uri: string | null;
      }
    >(
      `SELECT g.id, g.scope, g.created_at, g.last_used_at, c.name, c.client_uri
       FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
       WHERE g.user_id = ? AND g.revoked_at IS NULL AND EXISTS (
         SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id AND t.expires_at > ?
       )
       ORDER BY COALESCE(g.last_used_at, g.created_at) DESC`,
    )
    .all(me.id, nowIso())
    .map((g) => ({
      id: g.id,
      name: g.name,
      uri: g.client_uri,
      scopes: parseScopes(g.scope),
      connectedAt: g.created_at,
      lastUsedAt: g.last_used_at,
    }));
  const tokens = db
    .prepare<[number], PersonalAccessTokenRow>(
      `SELECT * FROM personal_access_tokens WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC, id DESC`,
    )
    .all(me.id)
    .map(toToken);
  return c.json({ mcpUrl: MCP_RESOURCE, apps, tokens });
});

const tokenBody = z.strictObject({
  name: z.string().trim().min(1).max(60),
  scopes: scopeList.default([SCOPE_READ, SCOPE_WRITE]),
});

connectionRoutes.post('/tokens', async (c) => {
  const me = c.get('user');
  const body = tokenBody.parse(await readJson(c));
  const live = db
    .prepare<[number], { n: number }>(
      'SELECT COUNT(*) AS n FROM personal_access_tokens WHERE user_id = ? AND revoked_at IS NULL',
    )
    .get(me.id)!.n;
  if (live >= MAX_TOKENS) {
    throw new HTTPException(400, { message: `at most ${MAX_TOKENS} tokens; revoke one first` });
  }
  const { token, row } = createPersonalAccessToken(
    me.id,
    body.name,
    parseScopes(body.scopes.join(' ')),
  );
  // The only time the plaintext is ever shown.
  return c.json({ token, ...toToken(row) });
});

connectionRoutes.delete('/tokens/:id', (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const { changes } = db
    .prepare(
      `UPDATE personal_access_tokens SET revoked_at = ?
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .run(nowIso(), id, me.id);
  if (changes === 0) throw NOT_FOUND();
  return c.body(null, 204);
});

connectionRoutes.delete('/apps/:id', (c) => {
  const me = c.get('user');
  const id = idParam.parse(c.req.param('id'));
  const grant = db
    .prepare<[number, number], { id: number }>(
      'SELECT id FROM oauth_grants WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    )
    .get(id, me.id);
  if (!grant) throw NOT_FOUND();
  revokeGrant(grant.id);
  return c.body(null, 204);
});
