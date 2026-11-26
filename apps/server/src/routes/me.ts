import type { FastifyPluginAsync } from 'fastify';
import { changePasswordRequestSchema, updateMeRequestSchema } from '@setryx/shared';
import { clearSessionCookie, requireUser, reservePasswordAttempt } from '../app.ts';
import { HttpError, parse } from '../http.ts';
import { verifyPassword } from '../passwords.ts';
import { deleteSession, deleteUserSessionById, deleteUserSessions, listUserSessions } from '../sessions.ts';
import { deleteUserApiTokens } from '../api-tokens.ts';
import { setPassword, toPublic, updateUser } from '../users.ts';

export const meRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;

  app.patch('/me', async (req) => {
    const user = requireUser(req);
    const body = parse(updateMeRequestSchema, req.body);
    const updated = updateUser(db, user.id, {
      displayName: body.displayName,
      settings: body.settings ? { ...user.settings, ...body.settings } : undefined,
    })!;
    return { user: toPublic(updated) };
  });

  app.post('/me/password', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(changePasswordRequestSchema, req.body);
    const refund = reservePasswordAttempt(req, reply, user.id); // shares the account's sign-in count
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      throw new HttpError(400, 'invalid_input', 'Your current password is wrong.', { currentPassword: 'This password is wrong.' });
    }
    refund();
    await setPassword(db, user.id, body.newPassword);
    // Sign out everywhere else; keep this device signed in.
    deleteUserSessions(db, user.id, req.sessionToken ?? undefined);
    if (body.revokeTokens) deleteUserApiTokens(db, user.id);
    return reply.status(204).send();
  });

  // ── Where you're signed in ──
  app.get('/me/sessions', async (req) => ({ sessions: listUserSessions(db, requireUser(req).id, req.sessionToken) }));

  /** Signs out everywhere except this device. */
  app.delete('/me/sessions', async (req, reply) => {
    deleteUserSessions(db, requireUser(req).id, req.sessionToken ?? undefined);
    return reply.status(204).send();
  });

  app.delete<{ Params: { id: string } }>('/me/sessions/:id', async (req, reply) => {
    const user = requireUser(req);
    const current = listUserSessions(db, user.id, req.sessionToken).find((x) => x.current);
    if (!deleteUserSessionById(db, user.id, req.params.id)) throw new HttpError(404, 'not_found', 'No such session.');
    if (current?.id === req.params.id && req.sessionToken) {
      deleteSession(db, req.sessionToken);
      clearSessionCookie(reply);
    }
    return reply.status(204).send();
  });
};
