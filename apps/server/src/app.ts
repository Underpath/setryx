import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { type Config, hostAllowed } from './config.ts';
import type { DB } from './db.ts';
import { type ResolvedToken, resolveApiToken, tokenMayUse } from './api-tokens.ts';
import { Backups } from './backup.ts';
import { Limits, LockoutWatch, RateLimiter } from './limits.ts';
import { DEVICE_COOKIE, DEVICE_KEEP_DAYS, newDeviceId, rememberDevice } from './devices.ts';
import { PasswordsBusyError } from './passwords.ts';
import { storageUsed } from './storage.ts';
import { HttpError, isSameOrigin, sendError } from './http.ts';
import { SESSION_COOKIE, resolveSession, sha256 } from './sessions.ts';
import { type UserRecord, findUserById } from './users.ts';
import { authRoutes } from './routes/auth.ts';
import { meRoutes } from './routes/me.ts';
import { adminRoutes } from './routes/admin.ts';
import { libraryRoutes } from './routes/library.ts';
import { workoutRoutes } from './routes/workouts.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { routineRoutes } from './routes/routines.ts';
import { statsRoutes } from './routes/stats.ts';
import { tokenRoutes } from './routes/tokens.ts';
import { openApiDocument } from './openapi.ts';
import { mcpRoutes } from './mcp/server.ts';

declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
    config: Config;
    backups: Backups;
    limits: Limits;
    rateLimiter: RateLimiter;
    lockouts: LockoutWatch;
    /** Marks the server's own in-process requests (MCP tools calling the API), which aren't counted twice. */
    internalKey: string;
  }
  interface FastifyRequest {
    user: UserRecord | null;
    sessionToken: string | null;
    /** Set when the request authenticated with a personal API token instead of the session cookie. */
    apiToken: ResolvedToken | null;
  }
}

export async function buildApp(config: Config, db: DB, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-setryx-internal"]'] } : false,
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
  });

  app.decorate('db', db);
  app.decorate('config', config);
  app.decorate('backups', new Backups(db, config.dataDir));
  app.decorate('limits', new Limits(db));
  app.decorate('rateLimiter', new RateLimiter());
  app.decorate('lockouts', new LockoutWatch());
  app.decorate('internalKey', randomBytes(24).toString('base64url'));
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);
  app.decorateRequest('apiToken', null);

  await app.register(cookie, { secret: config.sessionSecret });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return sendError(reply, err);
    if (err instanceof PasswordsBusyError) {
      reply.header('Retry-After', 5);
      return sendError(reply, new HttpError(503, 'busy', 'The server is busy checking passwords. Try again in a few seconds.'));
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return sendError(reply, new HttpError(status, 'bad_request', err instanceof Error ? err.message : 'Bad request.'));
    req.log.error(err);
    return sendError(reply, new HttpError(500, 'server_error', 'Something went wrong on the server. Check the container logs.'));
  });

  // Answer only to the server's own names, so a page on another name that
  // resolves here (DNS rebinding) is turned away. The health check calls 127.0.0.1.
  app.addHook('onRequest', async (req, reply) => {
    const allowed = config.allowedHosts;
    if (!allowed || hostAllowed(allowed, req.host) || req.url === '/api/health') return;
    return reply
      .status(421)
      .type('text/plain')
      .send(`This setryx server doesn’t answer to “${req.host}”. If that’s its address, add it to ALLOWED_HOSTS.`);
  });

  // Security headers on everything: no framing, no sniffing, and a CSP that only allows this origin.
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    if (req.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000');
  });

  // Resolve the API token or the session cookie on every API request.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // A personal API token. Cookies are ignored, and no Origin check is needed:
    // browsers never attach this header on their own, so it can't be forged cross-site.
    const auth = req.headers.authorization;
    if (auth !== undefined) {
      const invalid = new HttpError(401, 'invalid_token', 'This API token is wrong, expired or revoked.');
      const m = /^Bearer\s+(\S+)$/i.exec(auth);
      const token = m ? resolveApiToken(db, m[1]!) : null;
      if (!token) throw invalid;
      const user = findUserById(db, token.userId);
      if (!user || user.disabled) throw invalid;
      const route = req.routeOptions.url;
      if (route) {
        const access = tokenMayUse(token.scope, req.method, route);
        if (access === 'read_only') throw new HttpError(403, 'read_only_token', 'This token can only read. Create a read and write token to make changes.');
        if (access === 'not_allowed') throw new HttpError(403, 'not_allowed_with_token', 'API tokens can’t do this. Sign in to setryx to do it.');
      }
      req.user = user;
      req.apiToken = token;
      if (req.headers['x-setryx-internal'] !== app.internalKey) {
        limitRequest(req, reply, `token:${token.id}`, app.limits.get().tokenPerMinute, 1, 'This token');
      }
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isSameOrigin(req)) {
      throw new HttpError(403, 'bad_origin', 'This request came from another site and was blocked.');
    }
    const raw = req.cookies[SECURE_SESSION_COOKIE] ?? req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return clearSessionCookie(reply);
    const session = resolveSession(db, unsigned.value, app.limits.get());
    if (!session) return clearSessionCookie(reply);
    const user = findUserById(db, session.userId);
    if (!user || user.disabled) return clearSessionCookie(reply);
    req.user = user;
    req.sessionToken = unsigned.value;
    if (session.renewedUntil) setSessionCookie(req, reply, unsigned.value, session.renewedUntil);
  });

  // Each person's storage cap. Checked before anything that adds data; deleting
  // always works. 507 rather than 4xx, so the app's offline sync keeps a
  // session and retries it instead of dropping it.
  const ADDS_DATA = /^\/api\/v1\/(exercises|workouts|routines|sessions|import)(\/|$)/;
  app.addHook('preHandler', async (req) => {
    if (!req.user || !['POST', 'PUT', 'PATCH'].includes(req.method) || !ADDS_DATA.test(req.routeOptions.url ?? '')) return;
    const mb = app.limits.get().storageMbPerUser;
    if (mb === null || storageUsed(db, req.user.id) < mb * 1_000_000) return;
    throw new HttpError(507, 'storage_full', `You’ve used your ${mb} MB of storage on this server. Delete old workouts or sessions, or ask your admin to raise the limit.`);
  });

  // Polled by the Docker health check every 30 s; keep it out of the logs.
  app.get('/api/health', { logLevel: 'warn' }, async () => ({ ok: true }));

  // Describes everything an API token can do. Public: it holds no data.
  let spec: object | null = null;
  app.get('/api/v1/openapi.json', async () => (spec ??= openApiDocument()));

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(meRoutes);
      await api.register(adminRoutes, { prefix: '/admin' });
      await api.register(libraryRoutes);
      await api.register(workoutRoutes);
      await api.register(sessionRoutes);
      await api.register(routineRoutes);
      await api.register(statsRoutes);
      await api.register(tokenRoutes);
    },
    { prefix: '/api/v1' },
  );
  await app.register(mcpRoutes);

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

// Over HTTPS the cookie gets the __Host- prefix, which browsers only accept
// with Secure, Path=/ and no Domain, so another site can't plant one.
const SECURE_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;

export function useSecureCookie(req: FastifyRequest): boolean {
  const { cookieSecure, baseUrl } = req.server.config;
  if (cookieSecure === 'true') return true;
  if (cookieSecure === 'false') return false;
  return req.protocol === 'https' || !!baseUrl?.startsWith('https://');
}

export function setSessionCookie(req: FastifyRequest, reply: FastifyReply, token: string, expires: Date): void {
  const secure = useSecureCookie(req);
  reply.setCookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, token, { signed: true, httpOnly: true, sameSite: 'lax', secure, path: '/', expires });
  if (secure && req.cookies[SESSION_COOKIE]) reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(SECURE_SESSION_COOKIE, { path: '/', secure: true });
}

/**
 * Counts a request against a per-minute limit (null: no limit). Over it,
 * answers 429 with Retry-After; under it, says what's left.
 */
export function limitRequest(req: FastifyRequest, reply: FastifyReply, key: string, perMinute: number | null, cost: number, who: string): void {
  if (perMinute === null) return;
  const taken = req.server.rateLimiter.take(key, perMinute, cost);
  reply.header('RateLimit-Limit', perMinute);
  if (taken.ok) {
    reply.header('RateLimit-Remaining', taken.remaining);
    return;
  }
  reply.header('RateLimit-Remaining', 0).header('Retry-After', taken.retryAfterS);
  const wait = taken.retryAfterS === 1 ? 'a second' : `${taken.retryAfterS} seconds`;
  throw new HttpError(429, 'rate_limited', `${who} made more than ${perMinute} requests a minute, the limit on this server. Wait ${wait} and try again.`);
}

/**
 * Wrong passwords are limited per account, not per address: behind a proxy
 * addresses can be shared or faked, but the account being guessed at can't.
 * The attempt is taken before the password is checked, so guesses sent in
 * parallel can't all slip through; call the returned function to give it back
 * when the password was right.
 */
/**
 * Takes one wrong-password attempt from `bucket` before the password is checked
 * (and gives it back when it was right). `watchUserId` marks the account's
 * shared count, whose running out is logged and shown to admins.
 */
export function reservePasswordAttempt(req: FastifyRequest, reply: FastifyReply, bucket: string, watchUserId?: string): () => void {
  const key = `password:${bucket}`;
  const perMinute = req.server.limits.get().signInPerMinute;
  const taken = req.server.rateLimiter.take(key, perMinute);
  if (!taken.ok) {
    if (watchUserId && req.server.lockouts.refused(watchUserId)) {
      req.log.warn(
        { userId: watchUserId, ip: req.ip, refused: req.server.lockouts.count(watchUserId) },
        'Too many wrong passwords for this account; refusing sign-ins from devices it has not used before',
      );
    }
    reply.header('Retry-After', taken.retryAfterS);
    const wait = taken.retryAfterS === 1 ? 'a second' : `${taken.retryAfterS} seconds`;
    throw new HttpError(429, 'rate_limited', `Too many wrong passwords for this account. Wait ${wait} and try again.`);
  }
  return () => req.server.rateLimiter.refund(key, perMinute);
}

/** Password checks while signed in (changing it, making a token) count per session, apart from sign-in. */
export function sessionBucket(req: FastifyRequest): string {
  return req.sessionToken ? `session:${sha256(req.sessionToken).slice(0, 32)}` : `user:${req.user!.id}`;
}

const SECURE_DEVICE_COOKIE = `__Host-${DEVICE_COOKIE}`;

/** This browser's known-device id, if it has a valid one. */
export function deviceIdOf(req: FastifyRequest): string | null {
  const raw = req.cookies[SECURE_DEVICE_COOKIE] ?? req.cookies[DEVICE_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

/** Marks this browser as known to the account after a password sign-in. It outlives signing out on purpose. */
export function rememberThisDevice(req: FastifyRequest, reply: FastifyReply, userId: string): void {
  const id = deviceIdOf(req) ?? newDeviceId();
  rememberDevice(req.server.db, id, userId);
  const secure = useSecureCookie(req);
  const expires = new Date(Date.now() + DEVICE_KEEP_DAYS * 86_400_000);
  reply.setCookie(secure ? SECURE_DEVICE_COOKIE : DEVICE_COOKIE, id, { signed: true, httpOnly: true, sameSite: 'lax', secure, path: '/', expires });
  if (secure && req.cookies[DEVICE_COOKIE]) reply.clearCookie(DEVICE_COOKIE, { path: '/' });
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
