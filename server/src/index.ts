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
import { csrfProtect, rateLimit, CSP } from './security';
import authRoutes from './routes/auth';
import meRoutes from './routes/me';
import syncRoutes from './routes/sync';
import groupRoutes from './routes/groups';
import inviteRoutes from './routes/invites';
import friendRoutes from './routes/friends';
import expenseRoutes from './routes/expenses';

const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT ?? 8790);

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
app.use('/api/auth/*', rateLimit(20));
app.use('/api/*', rateLimit(300));
app.use('/api/*', bodyLimit({ maxSize: 64 * 1024 }));

app.route('/api/auth', authRoutes);
app.route('/api/me', meRoutes);
app.route('/api/sync', syncRoutes);
app.route('/api/groups', groupRoutes);
app.route('/api/invites', inviteRoutes);
app.route('/api/friends', friendRoutes);
app.route('/api/expenses', expenseRoutes);
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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`splitup api on http://localhost:${info.port}`);
});
