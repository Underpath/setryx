import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  adminCreateUserRequestSchema,
  adminResetPasswordRequestSchema,
  adminUpdateUserRequestSchema,
  appSettingsSchema,
  backupSettingsSchema,
  createInviteRequestSchema,
} from '@setryx/shared';
import { z } from 'zod';
import { requireAdmin } from '../app.ts';
import { listBackups } from '../backup.ts';
import { imagesAllowed, imagesStatus, removeAllImages, setImagesAllowed, startDownloadAll } from '../exercise-images.ts';
import { tx } from '../db.ts';
import { HttpError, parse } from '../http.ts';
import { createInvite, deleteInvite, listInvites } from '../invites.ts';
import { hashPassword } from '../passwords.ts';
import { deleteUserSessions } from '../sessions.ts';
import { deleteUserApiTokens } from '../api-tokens.ts';
import { mcpEnabled, setMcpEnabled } from '../mcp/server.ts';
import {
  countActiveAdmins,
  findUserById,
  findUserByUsername,
  getOpenSignup,
  insertUser,
  listUsers,
  setOpenSignup,
  setPassword,
  toPublic,
  updateUser,
} from '../users.ts';

type IdParams = { Params: { id: string } };

function originOf(req: FastifyRequest): string {
  return req.server.config.baseUrl ?? `${req.protocol}://${req.host}`;
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  app.addHook('preHandler', async (req) => void requireAdmin(req));

  // ── Users ──
  app.get('/users', async () => ({ users: listUsers(db).map(toPublic) }));

  app.post('/users', async (req, reply) => {
    const body = parse(adminCreateUserRequestSchema, req.body);
    const passwordHash = await hashPassword(body.password);
    const user = tx(db, () => {
      if (findUserByUsername(db, body.username)) {
        throw new HttpError(409, 'username_taken', 'That username is taken.', { username: 'That username is taken.' });
      }
      return insertUser(db, { username: body.username, displayName: body.displayName, passwordHash, role: body.role });
    });
    return reply.status(201).send({ user: toPublic(user) });
  });

  app.patch<IdParams>('/users/:id', async (req) => {
    const body = parse(adminUpdateUserRequestSchema, req.body);
    const user = tx(db, () => {
      const target = findUserById(db, req.params.id);
      if (!target) throw new HttpError(404, 'not_found', 'No such user.');
      const losesAdmin =
        target.role === 'admin' && !target.disabled && (body.role === 'user' || body.disabled === true);
      if (losesAdmin && countActiveAdmins(db) <= 1) {
        throw new HttpError(409, 'last_admin', 'This is the only admin. Make someone else an admin first.');
      }
      if (target.id === req.user!.id && body.disabled) {
        throw new HttpError(409, 'self_disable', 'You can’t turn off your own account.');
      }
      const updated = updateUser(db, target.id, body)!;
      if (body.disabled) deleteUserSessions(db, target.id);
      return updated;
    });
    return { user: toPublic(user) };
  });

  app.post<IdParams>('/users/:id/password', async (req, reply) => {
    const body = parse(adminResetPasswordRequestSchema, req.body);
    const target = findUserById(db, req.params.id);
    if (!target) throw new HttpError(404, 'not_found', 'No such user.');
    await setPassword(db, target.id, body.password);
    // Their old sessions stop working; resetting your own keeps this device signed in.
    deleteUserSessions(db, target.id, target.id === req.user!.id ? req.sessionToken ?? undefined : undefined);
    // An admin reset is for a lost or compromised account, so API tokens go too.
    deleteUserApiTokens(db, target.id);
    return reply.status(204).send();
  });

  // ── Invites ──
  app.get('/invites', async () => ({ invites: listInvites(db) }));

  app.post('/invites', async (req, reply) => {
    const body = parse(createInviteRequestSchema, req.body);
    const { invite, token } = createInvite(db, req.user!.id, body.expiresInDays);
    return reply.status(201).send({ invite, url: `${originOf(req)}/invite/${token}` });
  });

  app.delete<IdParams>('/invites/:id', async (req, reply) => {
    if (!deleteInvite(db, req.params.id)) throw new HttpError(404, 'not_found', 'No open invite with that id.');
    return reply.status(204).send();
  });

  // ── Backups ──
  const backupState = () => {
    const settings = app.backups.settings();
    return { settings, defaultDir: `${app.config.dataDir.replace(/\/$/, '')}/backups`, files: listBackups(settings.dir) };
  };
  app.get('/backups', async () => backupState());

  app.put('/backups', async (req) => {
    const body = parse(backupSettingsSchema, req.body);
    try {
      app.backups.update(body);
    } catch (err) {
      throw new HttpError(400, 'invalid_input', (err as Error).message, { dir: (err as Error).message });
    }
    return backupState();
  });

  app.post('/backups/now', async () => {
    try {
      app.backups.copyNow();
    } catch (err) {
      throw new HttpError(400, 'backup_failed', (err as Error).message);
    }
    return backupState();
  });

  // ── Exercise photos ──
  app.get('/exercise-images', async () => imagesStatus(db, app.config.dataDir));

  app.patch('/exercise-images', async (req) => {
    const { allowed } = parse(z.object({ allowed: z.boolean() }), req.body);
    setImagesAllowed(db, allowed);
    return imagesStatus(db, app.config.dataDir);
  });

  app.post('/exercise-images/download', async () => {
    if (!imagesAllowed(db)) throw new HttpError(409, 'not_allowed', 'Turn on exercise photos first.');
    startDownloadAll(db, app.config.dataDir);
    return imagesStatus(db, app.config.dataDir);
  });

  app.delete('/exercise-images', async () => {
    await removeAllImages(app.config.dataDir);
    return imagesStatus(db, app.config.dataDir);
  });

  // ── Server settings ──
  // MCP access for AI agents (with personal tokens); off until an admin turns it on.
  app.get('/mcp', async () => ({ enabled: mcpEnabled(db) }));
  app.patch('/mcp', async (req) => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    setMcpEnabled(db, enabled);
    return { enabled: mcpEnabled(db) };
  });

  app.get('/settings', async () => ({ openSignup: getOpenSignup(db) }));

  app.patch('/settings', async (req) => {
    const body = parse(appSettingsSchema, req.body);
    setOpenSignup(db, body.openSignup);
    return { openSignup: getOpenSignup(db) };
  });
};
