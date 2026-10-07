import { readFileSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { ZodError } from 'zod';
import { pruneExpired, type AppEnv } from './auth';
import { backupDaily, checkpoint, db } from './db';
import { csrfProtect, rateLimit, CSP } from './security';
import authRoutes from './routes/auth';
import meRoutes from './routes/me';
import syncRoutes from './routes/sync';
import groupRoutes from './routes/groups';
import inviteRoutes from './routes/invites';
import friendRoutes from './routes/friends';
import expenseRoutes from './routes/expenses';
import settlementRoutes from './routes/settlements';
import pushRoutes from './routes/push';
import receiptRoutes from './routes/receipts';

const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT ?? 8790);
const RECEIPT_SCAN_PATH = '/api/receipts/scan';

const app = new Hono<AppEnv>();

if (!IS_PROD) app.use(logger());
app.use(async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  // Covers every HTML response, including index.html served by serveStatic.
  if (c.res.headers.get('content-type')?.includes('text/html')) {
    c.header('Content-Security-Policy', CSP);
  }
});
app.use('/api/*', csrfProtect);
// Auth runs pre-session: key by IP so attacker-chosen cookies can't mint buckets.
app.use('/api/auth/*', rateLimit(20, 'ip'));
app.use('/api/*', rateLimit(300));
const smallBody = bodyLimit({ maxSize: 64 * 1024 });
// Receipt images get their own larger cap inside routes/receipts.ts; every
// other path keeps the 64 KB limit.
app.use('/api/*', (c, next) => (c.req.path === RECEIPT_SCAN_PATH ? next() : smallBody(c, next)));

app.route('/api/auth', authRoutes);
app.route('/api/me', meRoutes);
app.route('/api/sync', syncRoutes);
app.route('/api/groups', groupRoutes);
app.route('/api/invites', inviteRoutes);
app.route('/api/friends', friendRoutes);
app.route('/api/expenses', expenseRoutes);
app.route('/api/settlements', settlementRoutes);
app.route('/api/push', pushRoutes);
app.route('/api/receipts', receiptRoutes);
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

if (IS_PROD) {
  const dist = path.join(import.meta.dirname, '..', '..', 'web', 'dist');
  const indexHtml = readFileSync(path.join(dist, 'index.html'), 'utf8');
  app.use('*', serveStatic({ root: path.relative(process.cwd(), dist) }));
  app.get('*', (c) => {
    c.header('Content-Security-Policy', CSP);
    return c.html(indexHtml);
  });
}

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || 'error' }, err.status);
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    return c.json({ error: first ? `${where}${first.message}` : 'invalid input' }, 400);
  }
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});

pruneExpired();
setInterval(pruneExpired, 6 * 60 * 60 * 1000).unref();

const HOUR = 60 * 60 * 1000;
// Tracked so shutdown can let an in-flight snapshot finish before db.close().
let backupInFlight: Promise<void> | null = null;
const runBackup = () => {
  if (backupInFlight) return backupInFlight;
  backupInFlight = backupDaily()
    .catch((err) => console.error('backup failed', err))
    .finally(() => {
      backupInFlight = null;
    });
  return backupInFlight;
};
checkpoint();
void runBackup();
setInterval(checkpoint, HOUR).unref();
setInterval(runBackup, 24 * HOUR).unref();

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`splitup api on http://localhost:${info.port}`);
});

// Docker stops with SIGTERM: finish in-flight requests, then close the db so
// the WAL is checkpointed instead of being cut off by a SIGKILL.
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
    process.exit(0);
  };
  // Wait for in-flight requests AND any running backup (closing the db under
  // it would abort the snapshot), all bounded by the 5s hard deadline.
  server.close(() => {
    void (backupInFlight ?? Promise.resolve()).then(close);
  });
  setTimeout(close, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
