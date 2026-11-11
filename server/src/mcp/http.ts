import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  verifyBearerToken,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { MCP_RESOURCE, RESOURCE_METADATA_URL, SCOPES } from '../oauth/config';
import { principalOf, verifyAccessToken } from '../oauth/tokens';
import { createLimiter } from '../security';
import { createSplitupServer } from './server';

/**
 * POST/GET/DELETE /mcp — Streamable HTTP, stateless: every request gets a
 * fresh McpServer bound to the bearer token's owner (the SDK also serves
 * 2025-era clients statelessly, answering their session GET/DELETE with
 * 405). Bearer tokens only: cookies are never read here, so CSRF doesn't
 * apply and CORS can stay open for browser-based clients.
 */
const handler = createMcpHandler(
  ({ authInfo }) => {
    if (!authInfo) throw new Error('unauthenticated MCP request reached the handler');
    return createSplitupServer(authInfo);
  },
  {
    onerror: (err) => console.error('mcp:', err.message),
  },
);

export const closeMcp = () => handler.close();

// Per token and per user (a user may hold several tokens / connected apps).
const perToken = createLimiter(120);
const perUser = createLimiter(300);

const app = new Hono();

app.use(
  '/mcp',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Authorization',
      'Content-Type',
      'Accept',
      'Mcp-Session-Id',
      'MCP-Protocol-Version',
      'Mcp-Method',
      'Mcp-Name',
      'Last-Event-ID',
    ],
    exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
    maxAge: 86_400,
  }),
);
// Receipt images arrive as base64 inside the JSON-RPC body (3 MB → ~4 MB).
app.use(
  '/mcp',
  bodyLimit({
    maxSize: 6 * 1024 * 1024,
    onError: (c) => c.json({ error: 'request too large' }, 413),
  }),
);

app.all('/mcp', async (c) => {
  let auth: AuthInfo;
  try {
    auth = await verifyBearerToken(c.req.header('authorization'), {
      verifier: { verifyAccessToken },
      expectedResource: new URL(MCP_RESOURCE),
      resourceMetadataUrl: RESOURCE_METADATA_URL,
    });
  } catch (err) {
    // 401 + WWW-Authenticate: Bearer resource_metadata=…, scope=… — how
    // connectors discover the authorization server.
    return bearerAuthChallengeResponse(err, {
      resourceMetadataUrl: RESOURCE_METADATA_URL,
      requiredScopes: [...SCOPES],
    });
  }
  const principal = principalOf(auth);
  if (
    !perToken(`${principal.kind}:${principal.credentialId}`) ||
    !perUser(`u:${principal.userId}`)
  ) {
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'rate limit exceeded' } },
      429,
      { 'Retry-After': '60' },
    );
  }
  const res = await handler.fetch(c.req.raw, { authInfo: auth });
  if (!res.headers.get('content-type')?.includes('text/event-stream')) return res;
  // Reverse proxies (nginx & co.) must not buffer a streamed answer.
  const headers = new Headers(res.headers);
  headers.set('X-Accel-Buffering', 'no');
  headers.set('Cache-Control', 'no-cache, no-transform');
  return new Response(res.body, { status: res.status, headers });
});

export default app;
