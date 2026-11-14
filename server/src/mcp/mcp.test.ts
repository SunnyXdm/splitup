import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/**
 * End-to-end: boots the real server on a throwaway database, seeds users and
 * sessions directly, then drives the OAuth authorization server (DCR →
 * authorize → consent → token → refresh → revoke), personal access tokens,
 * and every MCP tool through the official SDK client.
 */

const SERVER_DIR = path.join(import.meta.dirname, '..', '..');
let dir: string;
let child: ChildProcess;
let base: string;
let seed: Database.Database;

const sessions = new Map<string, string>();
const ids = new Map<string, number>();
const id = (name: string) => ids.get(name)!;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') return reject(new Error('no port'));
      srv.close(() => resolve(addr.port));
    });
  });
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      await fetch(`${base}/.well-known/oauth-authorization-server`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('server did not start');
}

/** Cookie-authenticated API call, as the web app makes it. */
async function api(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      cookie: `splitup_session=${sessions.get(who)}`,
      'x-csrf': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const now = () => new Date().toISOString();

function addUser(name: string): void {
  const uid = Number(
    seed
      .prepare(
        "INSERT INTO users (shoo_sub, email, name, default_currency, created_at) VALUES (?, ?, ?, 'INR', ?)",
      )
      .run(`sub-${name}`, `${name.toLowerCase()}@example.com`, name, now()).lastInsertRowid,
  );
  const token = randomBytes(32).toString('hex');
  seed
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(
      createHash('sha256').update(token).digest('hex'),
      uid,
      now(),
      new Date(Date.now() + 86_400_000).toISOString(),
    );
  ids.set(name, uid);
  sessions.set(name, token);
}

function befriend(a: string, b: string): void {
  const stmt = seed.prepare(
    'INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)',
  );
  stmt.run(id(a), id(b), now());
  stmt.run(id(b), id(a), now());
}

function addGroup(name: string, members: string[], currency = 'INR'): number {
  const gid = Number(
    seed
      .prepare('INSERT INTO groups (name, currency, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(name, currency, id(members[0]), now()).lastInsertRowid,
  );
  for (const m of members) {
    seed
      .prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(gid, id(m), now());
  }
  return gid;
}

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'splitup-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/**
 * The subset of JSON Schema every major LLM tool-calling API accepts (it is
 * what a Gemini FunctionDeclaration allows, minus `nullable`/`format`):
 * returns one line per violation, empty when the schema is portable.
 */
function portabilityProblems(schema: unknown, at: string, root = false): string[] {
  const allowed = new Set(['type', 'description', 'properties', 'required', 'items', 'enum']);
  const simple = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return [`${at}: not a schema object`];
  }
  const s = schema as Record<string, unknown>;
  const problems = Object.keys(s)
    .filter((k) => !allowed.has(k))
    .map((k) => `${at}: keyword ${k}`);
  if (typeof s.type !== 'string' || !simple.has(s.type)) {
    problems.push(`${at}: type ${JSON.stringify(s.type)}`);
  }
  if (root && s.type !== 'object') problems.push(`${at}: root must be an object`);
  if (s.description !== undefined && typeof s.description !== 'string') {
    problems.push(`${at}: description`);
  }
  if (s.enum !== undefined) {
    const values = s.enum;
    if (s.type !== 'string' || !Array.isArray(values) || values.length === 0) {
      problems.push(`${at}: enum must be a non-empty list on a string`);
    } else if (!values.every((v) => typeof v === 'string')) {
      problems.push(`${at}: non-string enum value`);
    }
  }
  if (s.type === 'object') {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    if (typeof props !== 'object' || Array.isArray(props)) problems.push(`${at}: properties`);
    for (const [key, value] of Object.entries(props)) {
      problems.push(...portabilityProblems(value, `${at}.${key}`));
    }
    const required = s.required ?? [];
    if (!Array.isArray(required) || !required.every((k) => typeof k === 'string' && k in props)) {
      problems.push(`${at}: required lists unknown properties`);
    }
  } else if (s.properties !== undefined || s.required !== undefined) {
    problems.push(`${at}: properties/required on a non-object`);
  }
  if (s.type === 'array') {
    if (s.items === undefined) problems.push(`${at}: array without items`);
    else problems.push(...portabilityProblems(s.items, `${at}[]`));
    const item = s.items as { type?: unknown } | undefined;
    if (item?.type === 'array') problems.push(`${at}: nested arrays`);
  } else if (s.items !== undefined) {
    problems.push(`${at}: items on a non-array`);
  }
  return problems;
}

interface ToolOut {
  isError: boolean;
  text: string;
  data: any;
}

async function tool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOut> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
  return {
    isError: res.isError === true,
    text,
    data: res.structuredContent ?? null,
  };
}

async function createPat(who: string, scopes?: string[]): Promise<string> {
  const res = await api(who, 'POST', '/api/connections/tokens', {
    name: 'Test CLI',
    ...(scopes ? { scopes } : {}),
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.match(res.data.token, /^spu_/);
  return res.data.token;
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let goa: number;
let flat: number;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'splitup-mcp-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DB_PATH: path.join(dir, 'test.db'),
    PORT: String(port),
    NODE_ENV: 'test',
    APP_ORIGIN: base,
    // A dummy key enables scanning so its input guards can be tested; no
    // test reaches the model.
    ANTHROPIC_API_KEY: 'test-key-not-used',
    RECEIPT_PROVIDER: 'anthropic',
  };
  delete env.PUBLIC_ORIGIN;
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitForServer();
  seed = new Database(path.join(dir, 'test.db'));
  seed.pragma('busy_timeout = 5000');
  for (const n of ['Asha', 'Bilal', 'Chen', 'Dana']) addUser(n);
  befriend('Asha', 'Bilal');
  befriend('Asha', 'Chen');
  befriend('Bilal', 'Chen');
  goa = addGroup('Goa trip', ['Asha', 'Bilal', 'Chen']);
  flat = addGroup('Flat', ['Asha', 'Bilal']);
});

after(() => {
  seed?.close();
  child?.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('discovery', () => {
  it('answers /mcp without a token with 401 and a resource_metadata challenge', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{}',
    });
    assert.equal(res.status, 401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    assert.match(challenge, /^Bearer /);
    assert.match(
      challenge,
      new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`),
    );
    assert.match(challenge, /scope="splitup.read splitup.write"/);
  });

  it('ignores the session cookie on /mcp (Bearer only)', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        cookie: `splitup_session=${sessions.get('Asha')}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(res.status, 401);
  });

  it('publishes protected resource and authorization server metadata', async () => {
    for (const p of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const prm = (await (await fetch(`${base}${p}`)).json()) as any;
      assert.equal(prm.resource, `${base}/mcp`);
      assert.deepEqual(prm.authorization_servers, [base]);
      assert.deepEqual(prm.scopes_supported, ['splitup.read', 'splitup.write']);
    }
    const as = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as any;
    assert.equal(as.issuer, base);
    assert.equal(as.registration_endpoint, `${base}/oauth/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.equal(as.authorization_response_iss_parameter_supported, true);
  });
});

async function register(redirectUris: string[], extra: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: redirectUris, ...extra }),
  });
  return { status: res.status, data: (await res.json()) as any };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    scope: 'splitup.read splitup.write',
    resource: `${base}/mcp`,
    ...extra,
  });
  return `${base}/oauth/authorize?${q}`;
}

/** authorize → consent (as `who`) → the code delivered to the redirect URI. */
async function authorizeAndApprove(
  clientId: string,
  challenge: string,
  who = 'Asha',
  scopes?: string[],
): Promise<URL> {
  const res = await fetch(authorizeUrl(clientId, challenge), { redirect: 'manual' });
  assert.equal(res.status, 302);
  const consent = new URL(res.headers.get('location')!);
  assert.equal(consent.pathname, '/oauth/consent');
  const requestId = consent.searchParams.get('request')!;
  const preview = await api(who, 'GET', `/api/oauth/requests/${requestId}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.client.name, 'Claude');
  assert.equal(preview.data.client.redirectHost, 'claude.ai');
  const approve = await api(who, 'POST', `/api/oauth/requests/${requestId}/approve`, {
    ...(scopes ? { scopes } : {}),
  });
  assert.equal(approve.status, 200);
  return new URL(approve.data.redirectTo);
}

async function token(body: Record<string, string>) {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

describe('OAuth authorization server', () => {
  let clientId: string;

  it('registers clients dynamically, refusing redirects outside the allowlist', async () => {
    const ok = await register([CALLBACK]);
    assert.equal(ok.status, 201);
    assert.equal(ok.data.token_endpoint_auth_method, 'none');
    assert.equal(ok.data.client_secret, undefined);
    clientId = ok.data.client_id;

    const loopback = await register(['http://127.0.0.1:33418/callback']);
    assert.equal(loopback.status, 201);

    for (const bad of ['https://evil.example/cb', 'http://claude.ai/cb', 'myapp://cb']) {
      const res = await register([bad]);
      assert.equal(res.status, 400, bad);
      assert.equal(res.data.error, 'invalid_redirect_uri');
    }
  });

  it('never redirects to an unregistered redirect URI', async () => {
    const { challenge } = pkce();
    const res = await fetch(
      authorizeUrl(clientId, challenge, { redirect_uri: 'https://claude.ai/other' }),
      { redirect: 'manual' },
    );
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const unknown = await fetch(authorizeUrl('spc-nope', challenge), { redirect: 'manual' });
    assert.equal(unknown.status, 400);
  });

  it('requires PKCE S256 and the /mcp resource (errors go back with state and iss)', async () => {
    const noPkce = await fetch(authorizeUrl(clientId, '', { code_challenge_method: 'plain' }), {
      redirect: 'manual',
    });
    assert.equal(noPkce.status, 302);
    const loc = new URL(noPkce.headers.get('location')!);
    assert.equal(loc.origin + loc.pathname, CALLBACK);
    assert.equal(loc.searchParams.get('error'), 'invalid_request');
    assert.equal(loc.searchParams.get('state'), 'st-123');
    assert.equal(loc.searchParams.get('iss'), base);

    const { challenge } = pkce();
    const plain = await fetch(
      authorizeUrl(clientId, challenge, { code_challenge_method: 'plain' }),
      {
        redirect: 'manual',
      },
    );
    assert.equal(
      new URL(plain.headers.get('location')!).searchParams.get('error'),
      'invalid_request',
    );

    const wrongResource = await fetch(
      authorizeUrl(clientId, challenge, { resource: 'https://elsewhere.example/mcp' }),
      { redirect: 'manual' },
    );
    assert.equal(
      new URL(wrongResource.headers.get('location')!).searchParams.get('error'),
      'invalid_target',
    );
  });

  it('runs DCR → authorize → consent → token → /mcp tools/list → tools/call', async () => {
    const { verifier, challenge } = pkce();
    const back = await authorizeAndApprove(clientId, challenge);
    assert.equal(back.origin + back.pathname, CALLBACK);
    assert.equal(back.searchParams.get('state'), 'st-123');
    assert.equal(back.searchParams.get('iss'), base);
    const code = back.searchParams.get('code')!;

    // PKCE failure leaves the code unused…
    const badVerifier = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: pkce().verifier,
    });
    assert.equal(badVerifier.status, 400);
    assert.equal(badVerifier.data.error, 'invalid_grant');
    // …and so does a redirect_uri that differs from the authorize request.
    const badRedirect = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://claude.ai/other',
      client_id: clientId,
      code_verifier: verifier,
    });
    assert.equal(badRedirect.data.error, 'invalid_grant');

    const ok = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.match(ok.data.access_token, /^spa_/);
    assert.match(ok.data.refresh_token, /^spr_/);
    assert.equal(ok.data.token_type, 'Bearer');
    assert.equal(ok.data.expires_in, 3600);
    assert.equal(ok.data.scope, 'splitup.read splitup.write');

    const client = await mcpClient(ok.data.access_token);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['whoami', 'get_balance', 'add_expense', 'record_payment', 'scan_receipt']) {
      assert.ok(names.includes(n), n);
    }
    const del = tools.find((t) => t.name === 'delete_expense')!;
    assert.equal(del.annotations?.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === 'get_balance')!.annotations?.readOnlyHint, true);
    const me = await tool(client, 'whoami');
    assert.equal(me.isError, false);
    assert.equal(me.data.user.name, 'Asha');
    assert.equal(me.data.connectedVia, 'Claude');
    assert.equal(me.data.canWrite, true);
    await client.close();

    // The code is single-use; replaying it revokes everything it issued.
    const replay = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
    });
    assert.equal(replay.data.error, 'invalid_grant');
    const dead = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ok.data.access_token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(dead.status, 401);
  });

  it('rotates refresh tokens and treats reuse as theft', async () => {
    const { verifier, challenge } = pkce();
    const code = (await authorizeAndApprove(clientId, challenge)).searchParams.get('code')!;
    const first = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
    });
    const second = await token({
      grant_type: 'refresh_token',
      refresh_token: first.data.refresh_token,
      client_id: clientId,
    });
    assert.equal(second.status, 200);
    assert.notEqual(second.data.refresh_token, first.data.refresh_token);
    assert.notEqual(second.data.access_token, first.data.access_token);
    const client = await mcpClient(second.data.access_token);
    assert.equal((await tool(client, 'whoami')).isError, false);
    await client.close();

    const conn = await api('Asha', 'GET', '/api/connections');
    assert.equal(conn.data.apps.length, 1, 'reconnecting replaces the earlier grant');
    assert.equal(conn.data.apps[0].name, 'Claude');

    // Presenting the rotated-out token again kills the whole grant.
    const reuse = await token({
      grant_type: 'refresh_token',
      refresh_token: first.data.refresh_token,
      client_id: clientId,
    });
    assert.equal(reuse.data.error, 'invalid_grant');
    const after = await token({
      grant_type: 'refresh_token',
      refresh_token: second.data.refresh_token,
      client_id: clientId,
    });
    assert.equal(after.data.error, 'invalid_grant');
    assert.equal((await api('Asha', 'GET', '/api/connections')).data.apps.length, 0);
  });

  it('revokes tokens (RFC 7009) and lets the user disconnect an app', async () => {
    const { verifier, challenge } = pkce();
    const code = (await authorizeAndApprove(clientId, challenge)).searchParams.get('code')!;
    const t = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: verifier,
    });
    const revoke = await fetch(`${base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.data.access_token, client_id: clientId }),
    });
    assert.equal(revoke.status, 200);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.data.access_token}` },
    });
    assert.equal(res.status, 401);

    // The refresh token still works until the user disconnects the app.
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: t.data.refresh_token,
      client_id: clientId,
    });
    assert.equal(refreshed.status, 200);
    const apps = (await api('Asha', 'GET', '/api/connections')).data.apps;
    assert.equal(apps.length, 1);
    assert.equal((await api('Bilal', 'DELETE', `/api/connections/apps/${apps[0].id}`)).status, 404);
    assert.equal((await api('Asha', 'DELETE', `/api/connections/apps/${apps[0].id}`)).status, 204);
    const gone = await token({
      grant_type: 'refresh_token',
      refresh_token: refreshed.data.refresh_token,
      client_id: clientId,
    });
    assert.equal(gone.data.error, 'invalid_grant');
  });

  it('hands a denial back as access_denied, and grants only the scopes the user allowed', async () => {
    const { challenge } = pkce();
    const res = await fetch(authorizeUrl(clientId, challenge), { redirect: 'manual' });
    const requestId = new URL(res.headers.get('location')!).searchParams.get('request')!;
    const deny = await api('Asha', 'POST', `/api/oauth/requests/${requestId}/deny`);
    const back = new URL(deny.data.redirectTo);
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('state'), 'st-123');
    // The request is consumed.
    assert.equal((await api('Asha', 'GET', `/api/oauth/requests/${requestId}`)).status, 404);

    const p = pkce();
    const code = (
      await authorizeAndApprove(clientId, p.challenge, 'Asha', ['splitup.read'])
    ).searchParams.get('code')!;
    const t = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: p.verifier,
    });
    assert.equal(t.data.scope, 'splitup.read');
    const client = await mcpClient(t.data.access_token);
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes('get_balance'));
    assert.ok(!names.includes('add_expense'), 'write tools are hidden from read-only tokens');
    await assert.rejects(
      tool(client, 'add_expense', { group: 'Goa trip', description: 'x', amount: '1' }),
      /not found/,
    );
    await client.close();
  });

  it('authenticates confidential clients at the token endpoint', async () => {
    const reg = await register([CALLBACK], { token_endpoint_auth_method: 'client_secret_basic' });
    assert.equal(reg.status, 201);
    assert.ok(reg.data.client_secret);
    const p = pkce();
    const code = (await authorizeAndApprove(reg.data.client_id, p.challenge)).searchParams.get(
      'code',
    )!;
    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK,
      code_verifier: p.verifier,
    };
    const noSecret = await token({ ...body, client_id: reg.data.client_id });
    assert.equal(noSecret.status, 401);
    assert.equal(noSecret.data.error, 'invalid_client');
    const basic = Buffer.from(`${reg.data.client_id}:${reg.data.client_secret}`).toString('base64');
    const res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams(body),
    });
    assert.equal(res.status, 200);
  });
});

describe('personal access tokens', () => {
  it('creates, lists, uses and revokes a PAT', async () => {
    const pat = await createPat('Bilal');
    const list = await api('Bilal', 'GET', '/api/connections');
    assert.equal(list.data.mcpUrl, `${base}/mcp`);
    assert.equal(list.data.tokens.length, 1);
    assert.equal(list.data.tokens[0].hint, pat.slice(-4));
    assert.equal(JSON.stringify(list.data).includes(pat), false, 'never shown again');

    const client = await mcpClient(pat);
    assert.equal((await tool(client, 'whoami')).data.user.name, 'Bilal');
    await client.close();
    const used = await api('Bilal', 'GET', '/api/connections');
    assert.ok(used.data.tokens[0].lastUsedAt);

    assert.equal(
      (await api('Asha', 'DELETE', `/api/connections/tokens/${list.data.tokens[0].id}`)).status,
      404,
    );
    assert.equal(
      (await api('Bilal', 'DELETE', `/api/connections/tokens/${list.data.tokens[0].id}`)).status,
      204,
    );
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pat}` },
    });
    assert.equal(res.status, 401);
  });

  it('rejects token management without the CSRF header', async () => {
    const res = await fetch(`${base}/api/connections/tokens`, {
      method: 'POST',
      headers: {
        cookie: `splitup_session=${sessions.get('Asha')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(res.status, 403);
  });
});

describe('MCP tools', () => {
  let asha: Client;
  let dana: Client;
  let readOnly: Client;
  let dinnerId: number;
  let taxiId: number;

  before(async () => {
    asha = await mcpClient(await createPat('Asha'));
    dana = await mcpClient(await createPat('Dana'));
    readOnly = await mcpClient(await createPat('Chen', ['splitup.read']));
  });

  after(async () => {
    await Promise.all([asha?.close(), dana?.close(), readOnly?.close()]);
  });

  it('adds group and direct expenses with every split method', async () => {
    const dinner = await tool(asha, 'add_expense', {
      group: 'goa',
      description: 'Dinner',
      amount: '900',
      category: 'food',
      idempotency_key: 'mcp-test-dinner-1',
    });
    assert.equal(dinner.isError, false, dinner.text);
    dinnerId = dinner.data.expense.id;
    assert.equal(dinner.data.expense.amount.minor, 90_000);
    assert.equal(dinner.data.expense.amount.formatted.includes('900'), true);
    assert.equal(dinner.data.expense.yourShare.minor, 30_000);

    const replay = await tool(asha, 'add_expense', {
      group: 'goa',
      description: 'Dinner',
      amount: '900',
      category: 'food',
      idempotency_key: 'mcp-test-dinner-1',
    });
    assert.equal(replay.data.expense.id, dinnerId, 'idempotent retry');

    const taxi = await tool(asha, 'add_expense', {
      friend: 'bil',
      description: 'Taxi',
      amount: 300.5,
      split: {
        method: 'exact',
        values: [
          { person: 'me', value: '100' },
          { person: 'Bilal', value: '200.50' },
        ],
      },
    });
    assert.equal(taxi.isError, false, taxi.text);
    taxiId = taxi.data.expense.id;
    assert.equal(taxi.data.expense.group, null);

    const pct = await tool(asha, 'add_expense', {
      group: goa,
      description: 'Villa',
      amount: '1000',
      paid_by: 'Chen',
      split: {
        method: 'percent',
        values: [
          { person: 'Asha', value: '50' },
          { person: 'Bilal', value: '25' },
          { person: 'Chen', value: '25%' },
        ],
      },
    });
    assert.equal(pct.isError, false, pct.text);
    assert.equal(pct.data.expense.yourShare.minor, 50_000);

    const shares = await tool(asha, 'add_expense', {
      group: 'Flat',
      description: 'Groceries',
      amount: '90',
      payers: [
        { person: 'Asha', amount: '60' },
        { person: 'Bilal', amount: '30' },
      ],
      split: {
        method: 'shares',
        values: [
          { person: 'Asha', value: 2 },
          { person: 'Bilal', value: '1' },
        ],
      },
    });
    assert.equal(shares.isError, false, shares.text);
    assert.equal(shares.data.expense.yourShare.minor, 6_000);

    const row = seed
      .prepare('SELECT split_meta FROM expenses WHERE id = ?')
      .get(shares.data.expense.id) as { split_meta: string };
    assert.equal(JSON.parse(row.split_meta).mode, 'shares');
  });

  it('explains what is wrong instead of guessing', async () => {
    const wrongSum = await tool(asha, 'add_expense', {
      group: 'Goa',
      description: 'x',
      amount: '100',
      split: { method: 'percent', values: [{ person: 'Asha', value: '60' }] },
    });
    assert.equal(wrongSum.isError, true);
    assert.match(wrongSum.text, /100%/);
    const outsider = await tool(asha, 'add_expense', {
      group: 'Flat',
      description: 'x',
      amount: '100',
      paid_by: 'Chen',
    });
    assert.equal(outsider.isError, true);
    assert.match(outsider.text, /not one of the members of Flat/);
    const currency = await tool(asha, 'add_expense', {
      group: 'Flat',
      description: 'x',
      amount: '10',
      currency: 'USD',
    });
    assert.equal(currency.isError, true);
    const negative = await tool(asha, 'add_expense', {
      group: 'Flat',
      description: 'x',
      amount: '-5',
    });
    assert.equal(negative.isError, true);
  });

  it('reports balances that match the app’s math', async () => {
    const overall = await tool(asha, 'get_balance');
    assert.equal(overall.isError, false, overall.text);
    // Dinner: +600 · Villa: Asha owes 500 · Groceries: Asha +0 · Taxi: +200.50
    const net = overall.data.net.find((n: { currency: string }) => n.currency === 'INR');
    assert.equal(net.minor, 60_000 - 50_000 + 20_050);

    const bilal = await tool(asha, 'get_balance', { friend: 'Bilal' });
    const inr = bilal.data.balances[0];
    const scopes = inr.byScope.reduce(
      (s: number, x: { net: { minor: number } }) => s + x.net.minor,
      0,
    );
    assert.equal(scopes, inr.net.minor, 'slices add up to the friend balance');

    const group = await tool(asha, 'get_group', { group: 'Goa trip' });
    assert.equal(group.data.members.length, 3);
    assert.ok(group.data.suggestedSettlements.length > 0);
    const sum = group.data.members.reduce(
      (s: number, m: { balances: { net: { minor: number } }[] }) => s + m.balances[0].net.minor,
      0,
    );
    assert.equal(sum, 0, 'group nets add to zero');

    const friends = await tool(asha, 'list_friends');
    assert.equal(friends.data.friends.length, 2);
    const groups = await tool(asha, 'list_groups');
    assert.equal(groups.data.groups.length, 2);

    const why = await tool(asha, 'explain_balance', { friend: 'Bilal' });
    assert.equal(why.isError, false);
    assert.match(why.text, /Taxi/);
    const whyGroup = await tool(asha, 'explain_balance', { group: 'Goa', person: 'Chen' });
    assert.match(whyGroup.text, /pays/);
  });

  it('searches, reads and summarizes', async () => {
    const found = await tool(asha, 'search_expenses', { text: 'dinner' });
    assert.equal(found.data.total, 1);
    const food = await tool(asha, 'search_expenses', { category: 'food', group: 'goa' });
    assert.equal(food.data.total, 1);
    const direct = await tool(asha, 'search_expenses', { group: 'direct' });
    assert.equal(direct.data.expenses[0].id, taxiId);

    const detail = await tool(asha, 'get_expense', { expense_id: dinnerId });
    assert.equal(detail.data.shares.length, 3);
    assert.equal(detail.data.split.method, 'equal');
    assert.equal(detail.data.history[0].action, 'created');

    const summary = await tool(asha, 'spending_summary', { period: 'all' });
    assert.equal(summary.isError, false, summary.text);
    assert.equal(summary.data.currencies[0].yourShare.minor, 30_000 + 10_000 + 50_000 + 6_000);

    const activity = await tool(asha, 'list_activity', { limit: 3 });
    assert.match(activity.data.activity[0].summary, /\(via Test CLI\)$/);
  });

  it('edits with history, deletes only with confirm, and restores', async () => {
    const detail = await tool(asha, 'get_expense', { expense_id: dinnerId });
    const stale = await tool(asha, 'edit_expense', {
      expense_id: dinnerId,
      amount: '1200',
      expected_updated_at: '2000-01-01T00:00:00.000Z',
    });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /changed since you read it/);

    const edited = await tool(asha, 'edit_expense', {
      expense_id: dinnerId,
      amount: '1200',
      expected_updated_at: detail.data.updatedAt,
    });
    assert.equal(edited.isError, false, edited.text);
    assert.equal(edited.data.expense.yourShare.minor, 40_000, 'equal split re-applied');

    const unconfirmed = await asha.callTool({
      name: 'delete_expense',
      arguments: { expense_id: dinnerId },
    });
    assert.equal(unconfirmed.isError, true);
    const deleted = await tool(asha, 'delete_expense', { expense_id: dinnerId, confirm: true });
    assert.equal(deleted.isError, false, deleted.text);
    assert.equal((await tool(asha, 'search_expenses', { text: 'dinner' })).data.total, 0);

    const restored = await tool(asha, 'restore_expense', { expense_id: dinnerId });
    assert.equal(restored.isError, false, restored.text);
    assert.equal(restored.data.expense.amount.minor, 120_000);

    const revisions = seed
      .prepare('SELECT action FROM expense_revisions WHERE expense_id = ? ORDER BY revision')
      .all(dinnerId) as { action: string }[];
    assert.deepEqual(
      revisions.map((r) => r.action),
      ['created', 'updated', 'deleted', 'restored'],
    );
    const activity = seed
      .prepare('SELECT summary FROM activity WHERE expense_id = ? ORDER BY id')
      .all(dinnerId) as { summary: string }[];
    assert.equal(activity.length, 4);
    for (const a of activity) assert.match(a.summary, /\(via Test CLI\)$/);
  });

  it('accepts what portable schemas advertise: string ids, names, string amounts, "" clears', async () => {
    const asString = await tool(asha, 'get_expense', { expense_id: String(taxiId) });
    assert.equal(asString.isError, false, asString.text);
    assert.equal(asString.data.id, taxiId);
    assert.equal((await tool(asha, 'get_expense', { expense_id: taxiId })).data.id, taxiId);
    assert.equal((await tool(asha, 'get_expense', { expense_id: '1.5' })).isError, true);
    assert.equal((await tool(asha, 'get_expense', { expense_id: 'taxi' })).isError, true);

    const byName = await tool(asha, 'get_balance', { friend: 'Bilal' });
    const byId = await tool(asha, 'get_balance', { friend: String(id('Bilal')) });
    const byNumber = await tool(asha, 'get_balance', { friend: id('Bilal') });
    assert.equal(byName.isError, false, byName.text);
    assert.deepEqual(byId.data, byName.data);
    assert.deepEqual(byNumber.data, byName.data);

    const noted = await tool(asha, 'edit_expense', {
      expense_id: String(taxiId),
      amount: '300.50',
      notes: 'airport run',
    });
    assert.equal(noted.isError, false, noted.text);
    assert.equal(noted.data.expense.notes, 'airport run');
    const cleared = await tool(asha, 'edit_expense', { expense_id: taxiId, notes: '' });
    assert.equal(cleared.isError, false, cleared.text);
    assert.equal(cleared.data.expense.notes, undefined);
    await tool(asha, 'edit_expense', { expense_id: taxiId, notes: 'again' });
    const nulled = await tool(asha, 'edit_expense', { expense_id: taxiId, notes: null });
    assert.equal(nulled.isError, false, nulled.text);
    assert.equal(nulled.data.expense.notes, undefined, 'null still clears (older clients)');
  });

  it('records a full settle-up across groups and direct expenses, then undoes it', async () => {
    const before = await tool(asha, 'get_balance', { friend: 'Bilal' });
    const owed = before.data.balances[0].net.minor;
    assert.ok(owed > 0);
    const paid = await tool(asha, 'record_payment', {
      person: 'Bilal',
      method: 'upi',
      reference: 'UPI-1',
      idempotency_key: 'mcp-test-settle-1',
    });
    assert.equal(paid.isError, false, paid.text);
    assert.equal(paid.data.payment.cash.minor, owed);
    assert.equal(paid.data.payment.payer.name, 'Bilal');
    assert.equal(paid.data.balanceAfter.net.minor, 0);

    const after = await tool(asha, 'get_balance', { friend: 'Bilal' });
    assert.equal(after.data.balances.length, 0);

    const batch = seed
      .prepare('SELECT * FROM settlement_batches WHERE id = ?')
      .get(paid.data.payment.batchId) as { amount_cents: number; method: string };
    assert.equal(batch.amount_cents, owed);
    assert.equal(batch.method, 'upi');

    const noConfirm = await asha.callTool({
      name: 'undo_payment',
      arguments: { batch_id: paid.data.payment.batchId },
    });
    assert.equal(noConfirm.isError, true);
    const undone = await tool(asha, 'undo_payment', {
      expense_id: paid.data.payment.paymentRows[0],
      confirm: true,
    });
    assert.equal(undone.isError, false, undone.text);
    const back = await tool(asha, 'get_balance', { friend: 'Bilal' });
    assert.equal(back.data.balances[0].net.minor, owed);
  });

  it('settles inside one group with a partial amount', async () => {
    const res = await tool(asha, 'record_payment', {
      person: 'Chen',
      group: 'Goa',
      direction: 'i_paid',
      amount: '50',
    });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.data.payment.cash.minor, 5_000);
    assert.equal(res.data.payment.payer.name, 'Asha');
  });

  it('creates a group with friends', async () => {
    const res = await tool(asha, 'create_group', {
      name: 'Book club',
      currency: 'EUR',
      members: ['Bilal', 'chen@example.com'],
    });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.data.currency, 'EUR');
    assert.equal(res.data.members.length, 3);
  });

  it('lists, adds and skips due recurring bills', async () => {
    const today = (await tool(asha, 'whoami')).data.today;
    for (const description of ['Rent', 'Internet']) {
      const rule = await api('Asha', 'POST', '/api/recurring', {
        groupId: flat,
        friendId: null,
        template: {
          description,
          amountCents: 10_000,
          currency: 'INR',
          category: 'home',
          notes: null,
          split: {
            mode: 'equal',
            participants: [id('Asha'), id('Bilal')],
            payers: [{ userId: id('Asha'), cents: 10_000 }],
          },
        },
        cadence: 'monthly',
        anchorDate: today,
      });
      assert.equal(rule.status, 200, JSON.stringify(rule.data));
    }
    const list = await tool(asha, 'list_recurring');
    assert.equal(list.data.rules.length, 2);
    assert.equal(list.data.due.length, 2);
    const rent = list.data.due.find((d: { description: string }) => d.description === 'Rent');
    const internet = list.data.due.find(
      (d: { description: string }) => d.description === 'Internet',
    );
    const added = await tool(asha, 'add_due_bill', {
      occurrence_id: rent.occurrenceId,
      amount: '120',
    });
    assert.equal(added.isError, false, added.text);
    assert.equal(added.data.expense.amount.minor, 12_000);
    const skipped = await tool(asha, 'skip_due_bill', {
      occurrence_id: internet.occurrenceId,
      confirm: true,
    });
    assert.equal(skipped.isError, false, skipped.text);
    assert.equal((await tool(asha, 'list_recurring')).data.due.length, 0);
  });

  it('guards receipt scanning input (no private URLs, images only)', async () => {
    const local = await tool(asha, 'scan_receipt', { image_url: 'https://localhost/r.png' });
    assert.equal(local.isError, true);
    assert.match(local.text, /public/);
    const ip = await tool(asha, 'scan_receipt', { image_url: 'https://10.0.0.1/r.png' });
    assert.equal(ip.isError, true);
    const http = await tool(asha, 'scan_receipt', { image_url: 'http://example.com/r.png' });
    assert.equal(http.isError, true);
    const junk = await tool(asha, 'scan_receipt', {
      image_base64: Buffer.from('not an image').toString('base64'),
      mime_type: 'image/png',
    });
    assert.equal(junk.isError, true);
  });

  it('keeps every user inside their own visibility', async () => {
    assert.equal((await tool(dana, 'list_groups')).data.groups.length, 0);
    const group = await tool(dana, 'get_group', { group: goa });
    assert.equal(group.isError, true);
    const byName = await tool(dana, 'get_group', { group: 'Goa' });
    assert.equal(byName.isError, true);
    const expense = await tool(dana, 'get_expense', { expense_id: dinnerId });
    assert.equal(expense.isError, true);
    const del = await tool(dana, 'delete_expense', { expense_id: dinnerId, confirm: true });
    assert.equal(del.isError, true);
    const edit = await tool(dana, 'edit_expense', { expense_id: taxiId, amount: '1' });
    assert.equal(edit.isError, true);
    const add = await tool(dana, 'add_expense', { group: goa, description: 'x', amount: '1' });
    assert.equal(add.isError, true);
    const pay = await tool(dana, 'record_payment', {
      person: id('Asha'),
      amount: '5',
      direction: 'i_paid',
    });
    assert.equal(pay.isError, true);
    const undo = await tool(dana, 'undo_payment', { batch_id: 1, confirm: true });
    assert.equal(undo.isError, true);
    const search = await tool(dana, 'search_expenses', {});
    assert.equal(search.data.total, 0);
    const live = seed.prepare('SELECT deleted_at FROM expenses WHERE id = ?').get(dinnerId) as {
      deleted_at: string | null;
    };
    assert.equal(live.deleted_at, null);
  });

  it('read-only tokens cannot write', async () => {
    const names = (await readOnly.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('add_expense'));
    assert.ok(!names.includes('delete_expense'));
    const res = await tool(readOnly, 'get_balance');
    assert.equal(res.isError, false);
  });

  it('advertises only portable JSON Schema (Gemini / OpenAI-strict / OpenRouter safe)', async () => {
    const full = (await asha.listTools()).tools;
    const read = (await readOnly.listTools()).tools;
    assert.ok(full.length > read.length && read.length > 0);
    for (const t of [...full, ...read]) {
      assert.deepEqual(portabilityProblems(t.inputSchema, t.name, true), [], t.name);
      assert.equal(t.outputSchema, undefined, `${t.name} advertises no outputSchema`);
    }
    const add = full.find((t) => t.name === 'add_expense')!.inputSchema as any;
    assert.equal(add.properties.amount.type, 'string');
    assert.equal(add.properties.group.type, 'string');
    assert.match(add.properties.date.description, /YYYY-MM-DD/);
    assert.match(add.properties.currency.description, /ISO 4217/);
    const del = full.find((t) => t.name === 'delete_expense')!.inputSchema as any;
    assert.equal(del.properties.expense_id.type, 'integer');
    assert.equal(del.properties.confirm.type, 'boolean');
    const search = full.find((t) => t.name === 'search_expenses')!.inputSchema as any;
    assert.match(search.properties.limit.description, /1–100.*Default: 20/);
  });

  it('serves resources and prompts', async () => {
    const groups = await asha.readResource({ uri: 'splitup://groups' });
    const parsed = JSON.parse((groups.contents[0] as { text: string }).text);
    assert.ok(parsed.groups.length >= 2);
    const one = await asha.readResource({ uri: `splitup://groups/${goa}` });
    assert.equal(JSON.parse((one.contents[0] as { text: string }).text).name, 'Goa trip');
    const prompts = await asha.listPrompts();
    assert.deepEqual(prompts.prompts.map((p) => p.name).sort(), [
      'monthly-recap',
      'settle-up-summary',
    ]);
  });
});
