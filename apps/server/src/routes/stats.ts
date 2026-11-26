import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../app.ts';
import { HttpError, parse } from '../http.ts';
import { bestsFor, exerciseHistory, exerciseStats, sessionPoints } from '../stats-store.ts';

const sinceQuery = z.object({ days: z.coerce.number().int().min(1).max(1100).default(400) });
const bestsQuery = z.object({
  ids: z.string().max(4000).transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 100)),
  exclude: z.string().max(64).optional(),
});

export const statsRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  app.addHook('preHandler', async (req) => void requireUser(req));

  app.get('/stats/sessions', async (req) => {
    const { days } = parse(sinceQuery, req.query);
    return { sessions: sessionPoints(db, req.user!.id, new Date(Date.now() - days * 86_400_000).toISOString()) };
  });

  app.get('/stats/exercises', async (req) => ({ exercises: exerciseStats(db, req.user!.id) }));

  app.get<{ Params: { id: string } }>('/stats/exercises/:id', async (req) => {
    const h = exerciseHistory(db, req.user!.id, req.params.id);
    if (!h) throw new HttpError(404, 'not_found', 'No sessions with this exercise yet.');
    return { exerciseId: req.params.id, ...h };
  });

  app.get('/stats/bests', async (req) => {
    const q = parse(bestsQuery, req.query);
    return { bests: bestsFor(db, req.user!.id, q.ids, q.exclude) };
  });
};
