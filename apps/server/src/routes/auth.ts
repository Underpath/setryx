import type { FastifyPluginAsync } from 'fastify';
import { loginRequestSchema, registerRequestSchema, setupRequestSchema } from '@setryx/shared';
import { clearSessionCookie, deviceIdOf, rememberThisDevice, requireUser, reservePasswordAttempt, setSessionCookie } from '../app.ts';
import { knownDevice } from '../devices.ts';
import { tx } from '../db.ts';
import { HttpError, parse } from '../http.ts';
import { findOpenInvite, markInviteUsed } from '../invites.ts';
import { hashPassword, pretendVerify, verifyPassword } from '../passwords.ts';
import { sha256 } from '../sessions.ts';
import { createSession, deleteSession } from '../sessions.ts';
import { countUsers, findUserByUsername, getOpenSignup, insertUser, toPublic } from '../users.ts';


const usernameTaken = () =>
  new HttpError(409, 'username_taken', 'That username is taken.', { username: 'That username is taken.' });

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  // ── First-run setup: the first account becomes admin ──
  app.get('/setup', async () => ({ needsSetup: countUsers(db) === 0 }));

  app.post('/setup', async (req, reply) => {
    const body = parse(setupRequestSchema, req.body);
    const passwordHash = await hashPassword(body.password);
    const user = tx(db, () => {
      if (countUsers(db) > 0) throw new HttpError(409, 'already_set_up', 'This server already has an admin. Sign in instead.');
      return insertUser(db, { username: body.username, displayName: body.displayName, passwordHash, role: 'admin' });
    });
    const s = createSession(db, user.id, req.headers['user-agent'], app.limits.get());
    setSessionCookie(req, reply, s.token, s.expiresAt);
    rememberThisDevice(req, reply, user.id);
    return reply.status(201).send({ user: toPublic(user) });
  });

  // ── Sign in / out ──
  app.post('/auth/login', async (req, reply) => {
    const body = parse(loginRequestSchema, req.body);
    const user = findUserByUsername(db, body.username);
    // Unknown names are counted too, so a refusal doesn't reveal which accounts
    // exist. They share 65,536 counts, so a flood of made-up names can't grow memory.
    const account = user ? user.id : `name:${parseInt(sha256(body.username.trim().toLowerCase()).slice(0, 4), 16)}`;
    // A browser that has signed in to this account before has its own count, so
    // strangers using up the account's shared one can't lock its owner out.
    const deviceId = user ? deviceIdOf(req) : null;
    const known = user && deviceId ? knownDevice(db, deviceId, user.id) : null;
    const refund = known ? reservePasswordAttempt(req, reply, `${user!.id}:device:${known}`) : reservePasswordAttempt(req, reply, account, user?.id);
    const ok = user ? await verifyPassword(body.password, user.passwordHash, { priority: !!known }) : await pretendVerify();
    // The password is always checked, and a turned-off account gets the same
    // answer as a wrong password, so neither timing nor wording tells them apart.
    if (!user || !ok || user.disabled) throw new HttpError(401, 'bad_credentials', 'That username and password don’t match.');
    refund();
    // Signing in again from this browser replaces its old session rather than leaving it behind.
    if (req.sessionToken) deleteSession(db, req.sessionToken);
    const s = createSession(db, user.id, req.headers['user-agent'], app.limits.get());
    setSessionCookie(req, reply, s.token, s.expiresAt);
    rememberThisDevice(req, reply, user.id);
    return { user: toPublic(user) };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.sessionToken) deleteSession(db, req.sessionToken);
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.get('/auth/me', async (req) => ({ user: toPublic(requireUser(req)) }));

  // ── Sign up (invite link, or open signup if the admin allows it) ──
  app.get<{ Querystring: { invite?: string } }>('/auth/signup-info', async (req) => {
    const token = req.query.invite;
    return {
      openSignup: getOpenSignup(db),
      invite: token ? (findOpenInvite(db, token) ? 'valid' : 'invalid') : null,
    };
  });

  app.post('/auth/register', async (req, reply) => {
    const body = parse(registerRequestSchema, req.body);
    const passwordHash = await hashPassword(body.password);
    const user = tx(db, () => {
      const inviteId = body.inviteToken ? findOpenInvite(db, body.inviteToken) : null;
      if (body.inviteToken && !inviteId) {
        throw new HttpError(410, 'invite_invalid', 'This invite link has expired or was already used. Ask your admin for a new one.');
      }
      if (!inviteId && !getOpenSignup(db)) {
        throw new HttpError(403, 'signup_closed', 'Sign-up is closed on this server. Ask your admin for an invite link.');
      }
      if (findUserByUsername(db, body.username)) throw usernameTaken();
      const created = insertUser(db, { username: body.username, displayName: body.displayName, passwordHash, role: 'user' });
      if (inviteId) markInviteUsed(db, inviteId, created.id);
      return created;
    });
    const s = createSession(db, user.id, req.headers['user-agent'], app.limits.get());
    setSessionCookie(req, reply, s.token, s.expiresAt);
    rememberThisDevice(req, reply, user.id);
    return reply.status(201).send({ user: toPublic(user) });
  });
};
