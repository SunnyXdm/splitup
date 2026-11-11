import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

/** The JSON error answer every API route shares (also used for internal MCP calls). */
export function errorResponse(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    // A plain-object `cause` carries extra fields for the client (e.g. the
    // expense a reused idempotency key already recorded).
    const extra =
      err.cause !== null && typeof err.cause === 'object' && !(err.cause instanceof Error)
        ? err.cause
        : {};
    return c.json({ ...extra, error: err.message || 'error' }, err.status);
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    return c.json({ error: first ? `${where}${first.message}` : 'invalid input' }, 400);
  }
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
}
