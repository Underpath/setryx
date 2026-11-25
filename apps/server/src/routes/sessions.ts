import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { type WorkoutItem, sessionUploadSchema, targetUpdatesSchema } from '@setryx/shared';
import { requireUser } from '../app.ts';
import { HttpError, parse } from '../http.ts';
import { deleteSession, getSession, listSessions, upsertSession } from '../sessions-store.ts';
import { getWorkout, replaceWorkout } from '../workouts.ts';

type IdParams = { Params: { id: string } };
const idSchema = z.string().regex(/^[0-9a-f-]{8,64}$/i, 'Invalid session id.');
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), before: z.string().max(40).optional() });

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  app.addHook('preHandler', async (req) => void requireUser(req));

  app.get('/sessions', async (req) => {
    const q = parse(listQuery, req.query);
    return { sessions: listSessions(db, req.user!.id, q.limit, q.before) };
  });

  app.get<IdParams>('/sessions/:id', async (req) => {
    const s = getSession(db, req.user!.id, req.params.id);
    if (!s) throw new HttpError(404, 'not_found', 'No such session.');
    return { session: s };
  });

  // Idempotent: the device generates the id and may retry after a dropped connection.
  app.put<IdParams>('/sessions/:id', async (req) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(sessionUploadSchema, req.body);
    if (body.endedAt < body.startedAt) throw new HttpError(400, 'invalid_input', 'The session ends before it starts.');
    if (!upsertSession(db, req.user!.id, id, body)) throw new HttpError(409, 'conflict', 'That session id is already used.');
    return { session: getSession(db, req.user!.id, id) };
  });

  app.delete<IdParams>('/sessions/:id', async (req, reply) => {
    if (!deleteSession(db, req.user!.id, req.params.id)) throw new HttpError(404, 'not_found', 'No such session.');
    return reply.status(204).send();
  });

  // After a session: write what was actually done back into the workout as new targets.
  app.post<IdParams>('/workouts/:id/targets', async (req) => {
    const { updates } = parse(targetUpdatesSchema, req.body);
    const w = getWorkout(db, req.user!.id, req.params.id);
    if (!w) throw new HttpError(404, 'not_found', 'This workout doesn’t exist or was deleted.');
    const byId = new Map(updates.map((u) => [u.itemId, u]));
    let applied = 0;
    const patch = <T extends WorkoutItem>(it: T): T => {
      const u = byId.get(it.id);
      if (!u || it.kind !== 'exercise') return it;
      applied++;
      return {
        ...it,
        ...(u.targetReps !== undefined && it.targetType === 'reps' ? { targetReps: u.targetReps } : {}),
        ...(u.targetDurationS !== undefined && it.targetType === 'timed' ? { targetDurationS: u.targetDurationS } : {}),
        ...(u.targetWeight !== undefined ? { targetWeight: u.targetWeight } : {}),
      };
    };
    const items = w.items.map((it) => (it.kind === 'superset' ? { ...it, items: it.items.map(patch) } : patch(it)));
    const updated = replaceWorkout(db, req.user!.id, w.id, { name: w.name, icon: w.icon, notes: w.notes, items });
    return { applied, workout: updated };
  });
};
