import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { HttpError, isSameOrigin, sendError } from './http.ts';
import { SESSION_COOKIE, resolveSession } from './sessions.ts';
import { type UserRecord, findUserById } from './users.ts';
import { authRoutes } from './routes/auth.ts';
import { meRoutes } from './routes/me.ts';
import { adminRoutes } from './routes/admin.ts';
import { libraryRoutes } from './routes/library.ts';
import { workoutRoutes } from './routes/workouts.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
    config: Config;
  }
  interface FastifyRequest {
    user: UserRecord | null;
    sessionToken: string | null;
  }
}

export async function buildApp(config: Config, db: DB, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] } : false,
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
  });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return sendError(reply, err);
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return sendError(reply, new HttpError(429, 'rate_limited', 'Too many attempts. Wait a minute and try again.'));
    if (status && status >= 400 && status < 500) return sendError(reply, new HttpError(status, 'bad_request', err instanceof Error ? err.message : 'Bad request.'));
    req.log.error(err);
    return sendError(reply, new HttpError(500, 'server_error', 'Something went wrong on the server. Check the container logs.'));
  });

  // Resolve the session cookie on every API request.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isSameOrigin(req)) {
      throw new HttpError(403, 'bad_origin', 'This request came from another site and was blocked.');
    }
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return clearSessionCookie(reply);
    const session = resolveSession(db, unsigned.value);
    if (!session) return clearSessionCookie(reply);
    const user = findUserById(db, session.userId);
    if (!user || user.disabled) return clearSessionCookie(reply);
    req.user = user;
    req.sessionToken = unsigned.value;
    if (session.renewedUntil) setSessionCookie(req, reply, unsigned.value, session.renewedUntil);
  });

  // Polled by the Docker health check every 30 s; keep it out of the logs.
  app.get('/api/health', { logLevel: 'warn' }, async () => ({ ok: true }));

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(meRoutes);
      await api.register(adminRoutes, { prefix: '/admin' });
      await api.register(libraryRoutes);
      await api.register(workoutRoutes);
    },
    { prefix: '/api/v1' },
  );

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return sendError(reply, new HttpError(404, 'not_found', 'No such endpoint.'));
    // SPA fallback for app routes like /settings; missing files (anything with an extension) get a real 404.
    const path = req.url.split('?')[0] ?? '';
    if (config.webDist && (req.method === 'GET' || req.method === 'HEAD') && !/\.[a-z0-9]+$/i.test(path)) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send('Not found');
  });

  if (config.webDist) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      setHeaders(reply, path) {
        // Hashed assets can be cached forever; index.html must always be revalidated.
        reply.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  return app;
}

function useSecureCookie(req: FastifyRequest): boolean {
  const mode = req.server.config.cookieSecure;
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  return req.protocol === 'https';
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string, expires: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: useSecureCookie(req),
    path: '/',
    expires,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function requireUser(req: FastifyRequest): UserRecord {
  if (!req.user) throw new HttpError(401, 'not_signed_in', 'Sign in to continue.');
  return req.user;
}

export function requireAdmin(req: FastifyRequest): UserRecord {
  const user = requireUser(req);
  if (user.role !== 'admin') throw new HttpError(403, 'not_admin', 'Only an admin can do this.');
  return user;
}
