import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  type RoutineImportPreview,
  type ImportChoice,
  type ImportedItem,
  type WorkoutItem,
  bestMatches,
  exerciseIdsOf,
  routineImportRequestSchema,
  routineImportPreviewRequestSchema,
  parseRoutineExport,
  sameExerciseName,
  summarizeItems,
  workoutInputSchema,
} from '@setryx/shared';
import { requireUser } from '../app.ts';
import { tx } from '../db.ts';
import { customExercisesOf, getExercisesByIds, insertCustomExercise, listAllVisible } from '../exercises.ts';
import { HttpError, parse } from '../http.ts';
import { archiveWorkout, createWorkout, getWorkout, listWorkouts, reidItems, replaceWorkout } from '../workouts.ts';

type IdParams = { Params: { id: string } };

export const workoutRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app;
  app.addHook('preHandler', async (req) => void requireUser(req));

  const withExercises = (userId: string, workout: NonNullable<ReturnType<typeof getWorkout>>) => ({
    workout,
    exercises: getExercisesByIds(db, userId, exerciseIdsOf(workout.items)),
  });

  app.get('/workouts', async (req) => ({ workouts: listWorkouts(db, req.user!.id) }));

  app.get<IdParams>('/workouts/:id', async (req) => {
    const w = getWorkout(db, req.user!.id, req.params.id);
    if (!w) throw new HttpError(404, 'not_found', 'This workout doesn’t exist or was deleted.');
    return withExercises(req.user!.id, w);
  });

  app.post('/workouts', async (req, reply) => {
    const body = parse(workoutInputSchema, req.body);
    const w = createWorkout(db, req.user!.id, { ...body, items: body.items as WorkoutItem[] });
    return reply.status(201).send(withExercises(req.user!.id, w));
  });

  app.put<IdParams>('/workouts/:id', async (req) => {
    const body = parse(workoutInputSchema, req.body);
    const w = replaceWorkout(db, req.user!.id, req.params.id, { ...body, items: body.items as WorkoutItem[] });
    if (!w) throw new HttpError(404, 'not_found', 'This workout doesn’t exist or was deleted.');
    return withExercises(req.user!.id, w);
  });

  app.delete<IdParams>('/workouts/:id', async (req, reply) => {
    if (!archiveWorkout(db, req.user!.id, req.params.id)) throw new HttpError(404, 'not_found', 'This workout doesn’t exist or was deleted.');
    return reply.status(204).send();
  });

  app.post<IdParams>('/workouts/:id/duplicate', async (req, reply) => {
    const src = getWorkout(db, req.user!.id, req.params.id);
    if (!src) throw new HttpError(404, 'not_found', 'This workout doesn’t exist or was deleted.');
    const copy = createWorkout(db, req.user!.id, { name: `${src.name} (copy)`.slice(0, 80), icon: src.icon, notes: src.notes, items: reidItems(src.items) });
    return reply.status(201).send(withExercises(req.user!.id, copy));
  });

  // ── Routine import (JSON exports from the earlier tracker) ──

  const parseOr400 = (data: unknown) => {
    const parsed = parseRoutineExport(data);
    if (!parsed) throw new HttpError(400, 'unreadable_file', 'That file has no routines setryx can read. Pick a routines export in JSON format.');
    return parsed;
  };

  app.post('/import/routines/preview', async (req): Promise<RoutineImportPreview> => {
    const { data } = parse(routineImportPreviewRequestSchema, req.body);
    const parsed = parseOr400(data);
    const userId = req.user!.id;
    const library = listAllVisible(db, userId).filter((e) => !e.isCustom);
    const mine = customExercisesOf(db, userId);
    const existingNames = new Set(listWorkouts(db, userId).map((w) => w.name.toLowerCase()));
    return {
      workouts: parsed.workouts.map((w) => ({
        name: w.name,
        icon: w.icon,
        existingName: existingNames.has(w.name.toLowerCase()),
        ...summarizeItems(w.items as unknown as WorkoutItem[]),
      })),
      exercises: parsed.exercises.map((e) => {
        const existing = mine.find((m) => sameExerciseName(m.name, e.name)) ?? null;
        const suggestions = bestMatches(e.name, library, 3, 0.5).map((m) => ({ id: m.item.id, name: m.item.name, score: Math.round(m.score * 100) / 100 }));
        const exact = library.find((l) => sameExerciseName(l.name, e.name));
        const defaultChoice: ImportChoice = existing
          ? { type: 'existing', id: existing.id }
          : exact
            ? { type: 'library', id: exact.id }
            : { type: 'custom' };
        if (exact && !suggestions.some((s) => s.id === exact.id)) suggestions.unshift({ id: exact.id, name: exact.name, score: 1 });
        return {
          key: e.key,
          name: e.name,
          defaultType: e.defaultType,
          equipment: e.equipment,
          weights: [...new Set(e.weightsFound.map((w) => w.weight))],
          existing: existing ? { id: existing.id, name: existing.name } : null,
          suggestions,
          defaultChoice,
        };
      }),
    };
  });

  app.post('/import/routines', async (req, reply) => {
    const { data, choices } = parse(routineImportRequestSchema, req.body);
    const parsed = parseOr400(data);
    const userId = req.user!.id;
    const visible = new Set(listAllVisible(db, userId).map((e) => e.id));

    const created = tx(db, () => {
      // Resolve every imported exercise to a library id, one of the user's own, or a new custom exercise.
      const idByKey = new Map<string, string>();
      for (const e of parsed.exercises) {
        const choice = choices[e.key] ?? { type: 'custom' };
        if (choice.type !== 'custom' && visible.has(choice.id)) {
          idByKey.set(e.key, choice.id);
        } else {
          const ex = insertCustomExercise(db, userId, {
            name: e.name.slice(0, 100),
            defaultType: e.defaultType,
            category: null,
            primaryMuscles: [],
            secondaryMuscles: [],
            equipment: e.equipment.slice(0, 20),
            instructions: [],
          });
          idByKey.set(e.key, ex.id);
          visible.add(ex.id);
        }
      }
      const resolve = (it: ImportedItem): WorkoutItem => {
        if (it.kind === 'superset') return { ...it, id: randomUUID(), items: it.items.map((c) => resolve(c) as Exclude<WorkoutItem, { kind: 'superset' }>) };
        if (it.kind === 'rest') return { ...it, id: randomUUID() };
        const { exerciseKey, ...step } = it;
        return { ...step, id: randomUUID(), exerciseId: idByKey.get(exerciseKey)! };
      };
      return parsed.workouts.map((w) => {
        const input = parse(workoutInputSchema, { name: w.name, icon: w.icon, notes: null, items: w.items.map(resolve) });
        return createWorkout(db, userId, { ...input, items: input.items as WorkoutItem[] });
      });
    });
    return reply.status(201).send({ workouts: created.map((w) => ({ id: w.id, name: w.name })) });
  });

  // ── Export ──
  app.get('/export', async (req, reply) => {
    const userId = req.user!.id;
    const workouts = listWorkouts(db, userId).map((s) => getWorkout(db, userId, s.id)!);
    const usedIds = [...new Set(workouts.flatMap((w) => exerciseIdsOf(w.items)))];
    const used = getExercisesByIds(db, userId, usedIds);
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header('Content-Disposition', `attachment; filename="setryx-export-${stamp}.json"`);
    return {
      app: 'setryx',
      version: 1,
      exportedAt: new Date().toISOString(),
      // Library exercises are referenced by id; custom ones are included in full.
      exercises: customExercisesOf(db, userId),
      libraryExercises: Object.values(used).filter((e) => !e.isCustom).map((e) => ({ id: e.id, name: e.name })),
      workouts,
    };
  });
};
