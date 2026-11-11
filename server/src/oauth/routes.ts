import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { APP_ORIGIN } from '../auth';
import { db, nowIso, type OAuthClientRow, type OAuthGrantRow } from '../db';
import { rateLimit } from '../security';
import {
  ISSUER,
  MCP_RESOURCE,
  PUBLIC_ORIGIN,
  REDIRECT_HOSTS,
  REQUEST_TTL_MS,
  SCOPES,
  isOurResource,
  parseScopes,
} from './config';
import {
  ACCESS_PREFIX,
  REFRESH_PREFIX,
  issueTokens,
  revokeGrant,
  safeEqualHex,
  sha256,
} from './tokens';

/**
 * The OAuth 2.1 authorization server MCP connectors sign in through
 * (Claude, ChatGPT, …), per the MCP authorization spec:
 *
 * - RFC 9728 protected resource metadata for /mcp and RFC 8414 server metadata;
 * - RFC 7591 dynamic client registration (public clients, or a secret when
 *   one is asked for);
 * - /oauth/authorize: authorization code + PKCE S256 only, exact redirect URI
 *   match (loopback ports excepted, RFC 8252), RFC 8707 `resource` bound to
 *   /mcp, RFC 9207 `iss` on every response. The user signs in and consents in
 *   the web app (/oauth/consent), see routes/oauth-consent.ts;
 * - /oauth/token: code exchange and refresh with rotation (reuse of a rotated
 *   refresh token or of a code revokes the whole grant);
 * - /oauth/revoke (RFC 7009).
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why a redirect URI can't be registered, or null when it's acceptable. */
export function redirectUriProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (u.hash || raw.includes('#')) return 'must not contain a fragment';
  if (u.username || u.password) return 'must not contain credentials';
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(host) ? null : 'http is only allowed for loopback addresses';
  }
  if (u.protocol !== 'https:') return 'must be https (or http on a loopback address)';
  return REDIRECT_HOSTS.has(host) ? null : `redirects to ${host} are not allowed`;
}

/**
 * The redirect URI of an authorization request must equal a registered one
 * exactly — except that a loopback URI may use any port (RFC 8252 §7.3):
 * native apps pick a free port at sign-in time.
 */
export function matchesRegistered(uri: string, registered: string[]): boolean {
  if (registered.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname)) return false;
  return registered.some((r) => {
    try {
      const v = new URL(r);
      return (
        v.protocol === 'http:' &&
        v.hostname === u.hostname &&
        v.pathname === u.pathname &&
        v.search === u.search
      );
    } catch {
      return false;
    }
  });
}

export const clientRedirects = (client: OAuthClientRow): string[] =>
  JSON.parse(client.redirect_uris) as string[];

export function clientById(id: string | undefined | null): OAuthClientRow | null {
  if (!id || id.length > 100) return null;
  return (
    db.prepare<[string], OAuthClientRow>('SELECT * FROM oauth_clients WHERE id = ?').get(id) ?? null
  );
}

/** redirect_uri + params, always with our issuer (RFC 9207). */
export function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set('iss', ISSUER);
  return u.toString();
}

const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

const PKCE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export const authorizationServerMetadata = () => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  scopes_supported: [...SCOPES],
  authorization_response_iss_parameter_supported: true,
  service_documentation: `${PUBLIC_ORIGIN}/account`,
});

export const protectedResourceMetadata = () => ({
  resource: MCP_RESOURCE,
  authorization_servers: [ISSUER],
  scopes_supported: [...SCOPES],
  bearer_methods_supported: ['header'],
  resource_name: 'Splitup',
});

const app = new Hono();

// Discovery, registration, token and revocation are called by clients that
// may run in a browser (e.g. the MCP Inspector); none of them reads cookies,
// so permissive CORS is safe. /oauth/authorize is a top-level navigation.
const openCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version'],
  maxAge: 86_400,
});
app.use('/.well-known/*', openCors);
app.use('/oauth/register', openCors);
app.use('/oauth/token', openCors);
app.use('/oauth/revoke', openCors);

app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata()));
// RFC 9728: the path-suffixed document for /mcp, plus the root one for clients
// that probe the origin.
app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata()));
app.get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata()));

const oauthError = (c: Context, error: string, description: string, status: 400 | 401 = 400) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ error, error_description: description }, status);
};

// ---------------------------------------------------------------- registration

const registerBody = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().max(200).optional(),
  client_uri: z.string().max(2000).optional(),
  token_endpoint_auth_method: z.string().max(40).optional(),
  grant_types: z.array(z.string().max(60)).max(10).optional(),
  response_types: z.array(z.string().max(60)).max(10).optional(),
  scope: z.string().max(500).optional(),
});

/** Printable, single-line, bounded — it is shown on the consent screen. */
const cleanName = (raw: string | undefined) =>
  (raw ?? '')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'MCP client';

app.post('/oauth/register', rateLimit(30, 'ip', 60 * 60 * 1000), async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return oauthError(c, 'invalid_client_metadata', 'expected a JSON body');
  }
  const parsed = registerBody.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join('.') || 'body';
    return oauthError(c, 'invalid_client_metadata', `${where}: invalid`);
  }
  const body = parsed.data;
  for (const uri of body.redirect_uris) {
    const problem = redirectUriProblem(uri);
    if (problem) return oauthError(c, 'invalid_redirect_uri', `${uri}: ${problem}`);
  }
  const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
  if (
    !grantTypes.includes('authorization_code') ||
    grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')
  ) {
    return oauthError(
      c,
      'invalid_client_metadata',
      'grant_types must be authorization_code (+ refresh_token)',
    );
  }
  if (body.response_types && body.response_types.some((r) => r !== 'code')) {
    return oauthError(c, 'invalid_client_metadata', 'response_types must be code');
  }
  // Public clients (PKCE only) unless a secret is explicitly asked for.
  const method = body.token_endpoint_auth_method ?? 'none';
  if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic') {
    return oauthError(c, 'invalid_client_metadata', `unsupported auth method ${method}`);
  }
  let clientUri: string | null = null;
  if (body.client_uri) {
    try {
      const u = new URL(body.client_uri);
      if (u.protocol === 'https:') clientUri = u.toString();
    } catch {
      // ignore an unusable client_uri — it is informational only
    }
  }
  const id = `spc-${randomBytes(16).toString('hex')}`;
  const secret = method === 'none' ? null : randomBytes(32).toString('base64url');
  const name = cleanName(body.client_name);
  const issuedAt = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, auth_method, client_uri, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    secret === null ? null : sha256(secret),
    name,
    JSON.stringify(body.redirect_uris),
    method,
    clientUri,
    nowIso(),
  );
  c.header('Cache-Control', 'no-store');
  return c.json(
    {
      client_id: id,
      client_id_issued_at: issuedAt,
      ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
      client_name: name,
      ...(clientUri ? { client_uri: clientUri } : {}),
      redirect_uris: body.redirect_uris,
      grant_types: grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: method,
      scope: SCOPES.join(' '),
    },
    201,
  );
});

// --------------------------------------------------------------- authorization

function errorPage(c: Context, message: string) {
  c.header('Cache-Control', 'no-store');
  const safe = message.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Splitup · Can’t connect</title></head>` +
      `<body style="font-family:system-ui,sans-serif;background:#F3F0EE;color:#141413;` +
      `padding:48px 24px;max-width:32rem;margin:auto">` +
      `<h1 style="font-weight:500;letter-spacing:-0.02em">This app can’t connect</h1>` +
      `<p>${safe}</p><p><a href="/" style="color:#141413">Back to Splitup</a></p></body></html>`,
    400,
  );
}

app.get('/oauth/authorize', rateLimit(60, 'ip'), (c) => {
  const q = c.req.query();
  const client = clientById(q.client_id);
  if (!client) return errorPage(c, 'Unknown client. Remove the connector and add it again.');
  const registered = clientRedirects(client);
  const redirectUri = q.redirect_uri ?? (registered.length === 1 ? registered[0] : undefined);
  // Never redirect to an unverified URI: show the error here instead.
  if (!redirectUri || !matchesRegistered(redirectUri, registered)) {
    return errorPage(c, 'The redirect address doesn’t match this app’s registration.');
  }
  const state = q.state ?? null;
  const fail = (error: string, description: string) =>
    c.redirect(redirectWith(redirectUri, { error, error_description: description, state }));
  if (q.response_type !== 'code') {
    return fail('unsupported_response_type', 'only response_type=code is supported');
  }
  if (!q.code_challenge || !PKCE_RE.test(q.code_challenge)) {
    return fail('invalid_request', 'PKCE code_challenge is required');
  }
  if (q.code_challenge_method !== 'S256') {
    return fail('invalid_request', 'code_challenge_method must be S256');
  }
  if (q.resource !== undefined && !isOurResource(q.resource)) {
    return fail('invalid_target', `resource must be ${MCP_RESOURCE}`);
  }
  if (state !== null && state.length > 1000) return fail('invalid_request', 'state is too long');

  const id = randomBytes(24).toString('hex');
  const now = Date.now();
  db.prepare(
    `INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, scope, state, resource,
       created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sha256(id),
    client.id,
    redirectUri,
    q.code_challenge,
    parseScopes(q.scope).join(' '),
    state,
    MCP_RESOURCE,
    new Date(now).toISOString(),
    new Date(now + REQUEST_TTL_MS).toISOString(),
  );
  // Sign-in (if needed) and consent happen in the web app.
  return c.redirect(`${APP_ORIGIN}/oauth/consent?request=${id}`);
});

// ----------------------------------------------------------------------- token

async function formOrJson(c: Context): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const body = (await c.req.json()) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(body).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
    }
    const form = await c.req.parseBody();
    return Object.fromEntries(
      Object.entries(form).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return {};
  }
}

/**
 * Client authentication for the token and revocation endpoints: HTTP Basic,
 * client_secret in the body, or none for public clients. Returns the client,
 * or null when it's unknown or its secret is wrong.
 */
function authenticateClient(c: Context, body: Record<string, string>): OAuthClientRow | null {
  let id = body.client_id;
  let secret = body.client_secret;
  const basic = /^Basic\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
  if (basic) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const at = decoded.indexOf(':');
    if (at < 0) return null;
    id = decodeURIComponent(decoded.slice(0, at));
    secret = decodeURIComponent(decoded.slice(at + 1));
  }
  const client = clientById(id);
  if (!client) return null;
  if (client.auth_method === 'none') return client;
  if (!secret || !client.secret_hash || !safeEqualHex(sha256(secret), client.secret_hash)) {
    return null;
  }
  return client;
}

function grantById(id: number): OAuthGrantRow | null {
  return (
    db
      .prepare<[number], OAuthGrantRow>(
        'SELECT * FROM oauth_grants WHERE id = ? AND revoked_at IS NULL',
      )
      .get(id) ?? null
  );
}

app.post('/oauth/token', rateLimit(60, 'ip'), async (c) => {
  const body = await formOrJson(c);
  const client = authenticateClient(c, body);
  if (!client) return oauthError(c, 'invalid_client', 'client authentication failed', 401);
  if (body.resource !== undefined && !isOurResource(body.resource)) {
    return oauthError(c, 'invalid_target', `resource must be ${MCP_RESOURCE}`);
  }
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  if (body.grant_type === 'authorization_code') {
    const { code, redirect_uri: redirectUri, code_verifier: verifier } = body;
    if (!code || !verifier)
      return oauthError(c, 'invalid_request', 'code and code_verifier are required');
    const row = db
      .prepare<
        [string],
        {
          grant_id: number;
          redirect_uri: string;
          code_challenge: string;
          expires_at: string;
          used_at: string | null;
        }
      >(
        'SELECT grant_id, redirect_uri, code_challenge, expires_at, used_at FROM oauth_codes WHERE id = ?',
      )
      .get(sha256(code));
    const grant = row ? grantById(row.grant_id) : null;
    if (!row || !grant || grant.client_id !== client.id) {
      return oauthError(c, 'invalid_grant', 'unknown authorization code');
    }
    if (row.used_at !== null) {
      // A replayed code may have been intercepted: kill everything it issued.
      revokeGrant(grant.id);
      return oauthError(c, 'invalid_grant', 'authorization code already used');
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      return oauthError(c, 'invalid_grant', 'authorization code expired');
    }
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      return oauthError(c, 'invalid_grant', 'redirect_uri does not match');
    }
    if (!PKCE_RE.test(verifier) || pkceChallenge(verifier) !== row.code_challenge) {
      return oauthError(c, 'invalid_grant', 'PKCE verification failed');
    }
    const tokens = db.transaction(() => {
      const { changes } = db
        .prepare('UPDATE oauth_codes SET used_at = ? WHERE id = ? AND used_at IS NULL')
        .run(nowIso(), sha256(code));
      if (changes === 0) return null;
      return issueTokens(grant);
    })();
    if (!tokens) return oauthError(c, 'invalid_grant', 'authorization code already used');
    return c.json(tokens);
  }

  if (body.grant_type === 'refresh_token') {
    const refresh = body.refresh_token;
    if (!refresh || !refresh.startsWith(REFRESH_PREFIX)) {
      return oauthError(c, 'invalid_grant', 'unknown refresh token');
    }
    const row = db
      .prepare<[string], { grant_id: number; expires_at: string; used_at: string | null }>(
        "SELECT grant_id, expires_at, used_at FROM oauth_tokens WHERE id = ? AND kind = 'refresh'",
      )
      .get(sha256(refresh));
    const grant = row ? grantById(row.grant_id) : null;
    if (!row || !grant || grant.client_id !== client.id) {
      return oauthError(c, 'invalid_grant', 'unknown refresh token');
    }
    if (row.used_at !== null) {
      // Rotation reuse: someone holds an old copy. Disconnect the app.
      revokeGrant(grant.id);
      return oauthError(c, 'invalid_grant', 'refresh token already used');
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      return oauthError(c, 'invalid_grant', 'refresh token expired');
    }
    const tokens = db.transaction(() => {
      const { changes } = db
        .prepare('UPDATE oauth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL')
        .run(nowIso(), sha256(refresh));
      if (changes === 0) return null;
      return issueTokens(grant);
    })();
    if (!tokens) return oauthError(c, 'invalid_grant', 'refresh token already used');
    return c.json(tokens);
  }

  return oauthError(c, 'unsupported_grant_type', 'use authorization_code or refresh_token');
});

// ------------------------------------------------------------------ revocation

app.post('/oauth/revoke', rateLimit(60, 'ip'), async (c) => {
  const body = await formOrJson(c);
  const client = authenticateClient(c, body);
  if (!client) return oauthError(c, 'invalid_client', 'client authentication failed', 401);
  const token = body.token ?? '';
  if (token.startsWith(ACCESS_PREFIX) || token.startsWith(REFRESH_PREFIX)) {
    const row = db
      .prepare<[string], { grant_id: number; kind: string; client_id: string }>(
        `SELECT t.grant_id, t.kind, g.client_id FROM oauth_tokens t
         JOIN oauth_grants g ON g.id = t.grant_id WHERE t.id = ?`,
      )
      .get(sha256(token));
    // RFC 7009: answer 200 either way; only act on this client's own tokens.
    if (row && row.client_id === client.id) {
      if (row.kind === 'refresh') revokeGrant(row.grant_id);
      else db.prepare('DELETE FROM oauth_tokens WHERE id = ?').run(sha256(token));
    }
  }
  c.header('Cache-Control', 'no-store');
  return c.body(null, 200);
});

export default app;
