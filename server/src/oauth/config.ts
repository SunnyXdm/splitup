import { APP_ORIGIN } from '../auth';

/**
 * Public origin of this server — the OAuth issuer and the host of /mcp. In
 * production it is the app's own origin (APP_ORIGIN); PUBLIC_ORIGIN overrides
 * it when the API is reachable somewhere else than the web app.
 */
export const PUBLIC_ORIGIN = new URL(process.env.PUBLIC_ORIGIN ?? APP_ORIGIN).origin;
export const ISSUER = PUBLIC_ORIGIN;
/** The MCP endpoint, and the RFC 8707 resource (token audience) it accepts. */
export const MCP_RESOURCE = `${PUBLIC_ORIGIN}/mcp`;
export const RESOURCE_METADATA_URL = `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp`;

export const SCOPE_READ = 'splitup.read';
export const SCOPE_WRITE = 'splitup.write';
export const SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;
export type Scope = (typeof SCOPES)[number];

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const REQUEST_TTL_MS = 30 * 60 * 1000;

/**
 * Hosts an https redirect URI may point at. Only the hosted connectors need
 * one: Claude (claude.ai — web, desktop and mobile share its callback),
 * ChatGPT and Cursor's web agents. CLI and desktop clients use loopback
 * redirects, which are always allowed. OAUTH_REDIRECT_HOSTS (comma-separated)
 * adds more, e.g. for a self-hosted client.
 */
const DEFAULT_REDIRECT_HOSTS = ['claude.ai', 'claude.com', 'chatgpt.com', 'www.cursor.com'];
export const REDIRECT_HOSTS = new Set([
  ...DEFAULT_REDIRECT_HOSTS,
  ...(process.env.OAUTH_REDIRECT_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
]);

/**
 * Parses a space-separated scope string into the scopes we grant. Unknown
 * scopes (openid, offline_access, …) are ignored rather than refused, so a
 * client asking for extras still connects; none at all means both. Write
 * implies read — a write-only token couldn't look anything up.
 */
export function parseScopes(raw: string | null | undefined): Scope[] {
  const asked = new Set((raw ?? '').split(/\s+/).filter(Boolean));
  const known = SCOPES.filter((s) => asked.has(s));
  const granted = new Set<Scope>(known.length > 0 ? known : SCOPES);
  if (granted.has(SCOPE_WRITE)) granted.add(SCOPE_READ);
  return SCOPES.filter((s) => granted.has(s));
}

/** Same resource, ignoring one trailing slash (clients differ there). */
export function isOurResource(value: string): boolean {
  return value.replace(/\/$/, '') === MCP_RESOURCE;
}
