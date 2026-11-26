import type { FastifyPluginAsync } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { exerciseInputSchema } from '@setryx/shared';
import { requireUser } from '../app.ts';
import {
  archiveCustomExercise,
  exerciseFacets,
  getExercise,
  insertCustomExercise,
  searchExercises,
  updateCustomExercise,
} from '../exercises.ts';
import { HttpError, parse } from '../http.ts';

const searchQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  muscle: z.string().trim().max(60).optional(),
  equipment: z.string().trim().max(60).optional(),
  custom: z.enum(['1', 'true']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

type IdParams = { Params: { id: string } };

export const libraryRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  app.addHook('preHandler', async (req) => void requireUser(req));

  // Exercise photos, served only if they've been placed in /data/exercise-images.
  app.get<{ Params: { dir: string; file: string } }>('/exercise-images/:dir/:file', async (req, reply) => {
    const { dir, file } = req.params;
    if (!/^[A-Za-z0-9_()'.,-]{1,120}$/.test(dir) || dir.includes('..') || !/^\d{1,2}\.jpg$/.test(file)) throw new HttpError(404, 'not_found', 'No such image.');
    try {
      const data = await readFile(join(app.config.dataDir, 'exercise-images', dir, file));
      return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=604800').send(data);
    } catch {
      throw new HttpError(404, 'not_found', 'No such image.');
    }
  });

  app.get('/exercises', async (req) => {
    const q = parse(searchQuerySchema, req.query);
    return searchExercises(db, req.user!.id, { ...q, custom: !!q.custom });
  });

  app.get('/exercises/facets', async (req) => exerciseFacets(db, req.user!.id));

  app.get<IdParams>('/exercises/:id', async (req) => {
    const ex = getExercise(db, req.user!.id, req.params.id);
    if (!ex) throw new HttpError(404, 'not_found', 'No such exercise.');
    const { ownerId: _o, archived, ...exercise } = ex;
    return { exercise, archived };
  });

  app.post('/exercises', async (req, reply) => {
    const body = parse(exerciseInputSchema, req.body);
    return reply.status(201).send({ exercise: insertCustomExercise(db, req.user!.id, body) });
  });

  app.put<IdParams>('/exercises/:id', async (req) => {
    const body = parse(exerciseInputSchema, req.body);
    const ex = updateCustomExercise(db, req.user!.id, req.params.id, body);
    if (!ex) throw new HttpError(404, 'not_found', 'Only your own exercises can be edited. Duplicate a library exercise to change it.');
    return { exercise: ex };
  });

  app.delete<IdParams>('/exercises/:id', async (req, reply) => {
    if (!archiveCustomExercise(db, req.user!.id, req.params.id)) {
      throw new HttpError(404, 'not_found', 'Only your own exercises can be removed.');
    }
    return reply.status(204).send();
  });
};
