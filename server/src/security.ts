import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getConnInfo } from '@hono/node-server/conninfo';
import { getCookie } from 'hono/cookie';
import { APP_ORIGIN, COOKIE_NAME, hasLiveSession } from './auth';

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
const MAX_BUCKETS = 50_000;

/**
 * Behind a reverse proxy every socket address is the proxy's, so all clients
 * would share one bucket. With TRUST_PROXY set, take the RIGHTMOST
 * X-Forwarded-For entry — the one our own proxy appended; anything left of it
 * is client-controlled — then X-Real-IP, then the socket.
 */
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY ?? '');

function ipKey(c: Context): string {
  if (TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for');
    const last = xff?.split(',').pop()?.trim();
    if (last) return `ip:${last}`;
    const real = c.req.header('x-real-ip')?.trim();
    if (real) return `ip:${real}`;
  }
  try {
    return `ip:${getConnInfo(c).remote.address ?? 'unknown'}`;
  } catch {
    return 'ip:unknown';
  }
}

function clientKey(c: Context): string {
  // Prefer the session (stable per user) — but only for a cookie that maps to
  // a live session row; junk or expired cookies must not mint fresh buckets.
  const cookie = getCookie(c, COOKIE_NAME);
  if (cookie && hasLiveSession(cookie)) return `s:${cookie.slice(0, 16)}`;
  return ipKey(c);
}

/**
 * Fixed-window in-memory rate limiter; fine for a single-process deployment.
 * 'ip' mode keys strictly by remote address — use it for pre-session routes
 * (auth), where a cookie-derived key would be attacker-chosen.
 *
 * Buckets are re-inserted whenever their window restarts, so the Map's
 * insertion order is windowStart order: expired buckets are always at the
 * front and eviction is amortized O(1). A hard cap drops the oldest bucket.
 */
export function rateLimit(
  maxPerWindow: number,
  mode: 'session' | 'ip' = 'session',
  windowMs = WINDOW_MS,
) {
  const buckets = new Map<string, Bucket>();
  return async (c: Context, next: Next) => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (now - b.windowStart <= windowMs && buckets.size < MAX_BUCKETS) break;
      buckets.delete(k);
    }
    const key = mode === 'ip' ? ipKey(c) : clientKey(c);
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
      buckets.delete(key);
      buckets.set(key, { count: 1, windowStart: now });
    } else if (++bucket.count > maxPerWindow) {
      throw new HTTPException(429, { message: 'too many requests' });
    }
    await next();
  };
}

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' https://shoo.dev; img-src 'self' data: https://*.googleusercontent.com; " +
  "font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
