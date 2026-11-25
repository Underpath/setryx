import type { FastifyPluginAsync } from 'fastify';
import { routineActiveSchema, routineInputSchema } from '@setryx/shared';
import { requireUser } from '../app.ts';
import { HttpError, parse } from '../http.ts';
import { createRoutine, deleteRoutine, getRoutine, listRoutines, replaceRoutine, restartRoutine, setRoutineActive } from '../routines.ts';

type IdParams = { Params: { id: string } };
const notFound = () => new HttpError(404, 'not_found', 'This routine doesn’t exist or was deleted.');

export const routineRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  app.addHook('preHandler', async (req) => void requireUser(req));

  app.get('/routines', async (req) => ({ routines: listRoutines(db, req.user!.id) }));

  app.get<IdParams>('/routines/:id', async (req) => {
    const r = getRoutine(db, req.user!.id, req.params.id);
    if (!r) throw notFound();
    return { routine: r };
  });

  app.post('/routines', async (req, reply) => {
    const body = parse(routineInputSchema, req.body);
    return reply.status(201).send({ routine: createRoutine(db, req.user!.id, body) });
  });

  app.put<IdParams>('/routines/:id', async (req) => {
    const body = parse(routineInputSchema, req.body);
    const r = replaceRoutine(db, req.user!.id, req.params.id, body);
    if (!r) throw notFound();
    return { routine: r };
  });

  // Pause or reactivate.
  app.patch<IdParams>('/routines/:id', async (req) => {
    const { active } = parse(routineActiveSchema, req.body);
    const r = setRoutineActive(db, req.user!.id, req.params.id, active);
    if (!r) throw notFound();
    return { routine: r };
  });

  app.post<IdParams>('/routines/:id/restart', async (req) => {
    const r = restartRoutine(db, req.user!.id, req.params.id);
    if (!r) throw notFound();
    return { routine: r };
  });

  app.delete<IdParams>('/routines/:id', async (req, reply) => {
    if (!deleteRoutine(db, req.user!.id, req.params.id)) throw notFound();
    return reply.status(204).send();
  });
};
