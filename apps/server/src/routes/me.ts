import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { changePasswordRequestSchema, updateMeRequestSchema } from '@setryx/shared';
import { requireUser } from '../app.ts';
import { HttpError, parse } from '../http.ts';
import { verifyPassword } from '../passwords.ts';
import { deleteUserSessions } from '../sessions.ts';
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

  app.post('/me/password', { config: { rateLimit: { max: (r: FastifyRequest) => r.server.limits.get().signInPerMinute, timeWindow: '1 minute' } } }, async (req, reply) => {
    const user = requireUser(req);
    const body = parse(changePasswordRequestSchema, req.body);
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      throw new HttpError(400, 'invalid_input', 'Your current password is wrong.', { currentPassword: 'This password is wrong.' });
    }
    await setPassword(db, user.id, body.newPassword);
    // Sign out everywhere else; keep this device signed in.
    deleteUserSessions(db, user.id, req.sessionToken ?? undefined);
    return reply.status(204).send();
  });
};
