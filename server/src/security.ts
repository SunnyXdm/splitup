import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getConnInfo } from '@hono/node-server/conninfo';
import { getCookie } from 'hono/cookie';
import { APP_ORIGIN } from './auth';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defense for cookie auth: mutations must carry the custom X-CSRF header
 * (impossible cross-site without a CORS preflight we never allow), and any
 * Origin header present must match our own origin.
 */
export async function csrfProtect(c: Context, next: Next) {
  if (!SAFE_METHODS.has(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin && origin !== APP_ORIGIN) {
      throw new HTTPException(403, { message: 'cross-origin request rejected' });
    }
    if (c.req.header('x-csrf') !== '1') {
      throw new HTTPException(403, { message: 'missing CSRF header' });
    }
  }
  await next();
}

interface Bucket {
  count: number;
  windowStart: number;
}
const WINDOW_MS = 60_000;

function ipKey(c: Context): string {
  try {
    return `ip:${getConnInfo(c).remote.address ?? 'unknown'}`;
  } catch {
    return 'ip:unknown';
  }
}

function clientKey(c: Context): string {
  // Prefer the session cookie (stable per user) — but only when it has the
  // real token format; arbitrary junk cookies must not mint fresh buckets.
  const cookie = getCookie(c, 'splitup_session');
  if (cookie && /^[0-9a-f]{64}$/.test(cookie)) return `s:${cookie.slice(0, 16)}`;
  return ipKey(c);
}

/**
 * Fixed-window in-memory rate limiter; fine for a single-process deployment.
 * 'ip' mode keys strictly by remote address — use it for pre-session routes
 * (auth), where a cookie-derived key would be attacker-chosen.
 */
export function rateLimit(maxPerMinute: number, mode: 'session' | 'ip' = 'session') {
  const buckets = new Map<string, Bucket>();
  return async (c: Context, next: Next) => {
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) if (now - b.windowStart > WINDOW_MS) buckets.delete(k);
    }
    const key = mode === 'ip' ? ipKey(c) : clientKey(c);
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > WINDOW_MS) {
      buckets.set(key, { count: 1, windowStart: now });
    } else if (++bucket.count > maxPerMinute) {
      throw new HTTPException(429, { message: 'too many requests' });
    }
    await next();
  };
}

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' https://shoo.dev; img-src 'self' data: https://*.googleusercontent.com; " +
  "font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
