import { z } from 'zod';
import {
  exerciseInputSchema,
  exerciseSchema,
  routineActiveSchema,
  routineInputSchema,
  sessionUploadSchema,
  setLogSchema,
  targetUpdatesSchema,
  workoutInputSchema,
  workoutItemSchema,
} from '@setryx/shared';

// The OpenAPI description of what a personal API token can do. Request bodies
// come straight from the shared Zod schemas the server validates with, so the
// document can't drift from what's accepted.

type Json = Record<string, unknown>;

const fromZod = (schema: z.ZodType): Json => {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  return rest;
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: 'string' };
const date = { type: 'string', format: 'date-time' };
const int = { type: 'integer' };
const num = { type: 'number' };
const nullable = (s: Json) => ({ anyOf: [s, { type: 'null' }] });
const obj = (properties: Json, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const arr = (items: Json) => ({ type: 'array', items });

const bests = obj({ weight: nullable(num), e1rm: nullable(num), reps: nullable(int), durationS: nullable(int) });
const sessionSummary = obj({
  id: str,
  workoutId: nullable(str),
  routineId: nullable(str),
  routineEntryId: nullable(str),
  workoutName: str,
  icon: str,
  startedAt: date,
  endedAt: date,
  durationMs: int,
  status: { type: 'string', enum: ['completed', 'ended_early'] },
  setCount: int,
  volumeKg: num,
});

const schemas: Record<string, Json> = {
  Error: obj({ error: { ...str, description: 'A stable code, like not_found or invalid_input.' }, message: str, fields: { type: 'object', additionalProperties: str } }, ['error', 'message']),
  Exercise: fromZod(exerciseSchema),
  ExerciseInput: fromZod(exerciseInputSchema),
  WorkoutItem: fromZod(workoutItemSchema),
  WorkoutInput: fromZod(workoutInputSchema),
  Workout: obj({ id: str, name: str, icon: str, notes: nullable(str), items: arr(ref('WorkoutItem')), createdAt: date, updatedAt: date }),
  WorkoutSummary: obj({ id: str, name: str, icon: str, blockCount: int, supersetCount: int, stepCount: int, estimatedS: int, updatedAt: date }),
  WorkoutWithExercises: obj({
    workout: ref('Workout'),
    exercises: { type: 'object', additionalProperties: ref('Exercise'), description: 'The exercises the workout uses, by id.' },
  }),
  RoutineInput: fromZod(routineInputSchema),
  Routine: obj({
    id: str,
    name: str,
    mode: { type: 'string', enum: ['repeat', 'once', 'weekly'] },
    active: { type: 'boolean' },
    startedAt: { ...date, description: 'Progress counts from here; restarting moves it to now.' },
    entries: arr(obj({ id: str, workoutId: str, weekday: nullable(int), workoutName: nullable(str), icon: str })),
    runs: arr(obj({ entryId: str, startedAt: date })),
    createdAt: date,
    updatedAt: date,
  }),
  SessionUpload: fromZod(sessionUploadSchema),
  SessionSummary: sessionSummary,
  SessionDetail: {
    allOf: [
      ref('SessionSummary'),
      obj({
        notes: nullable(str),
        items: arr(ref('WorkoutItem')),
        exercises: { type: 'object', additionalProperties: obj({ name: str, equipment: arr(str), instructions: arr(str) }) },
        logs: arr(fromZod(setLogSchema)),
      }),
    ],
  },
  TargetUpdates: fromZod(targetUpdatesSchema),
  Bests: bests,
  ExerciseStat: obj({ exerciseId: str, name: str, sessions: int, lastDoneAt: date, bests: ref('Bests') }),
  ExerciseHistoryEntry: obj({ sessionId: str, startedAt: date, workoutName: str, sets: arr(obj({ reps: nullable(int), weight: nullable(num), durationS: nullable(int) })) }),
};

// ── Helpers for operations ──

const json = (schema: Json) => ({ content: { 'application/json': { schema } } });
const ok = (description: string, schema: Json, status = '200') => ({ [status]: { description, ...json(schema) } });
const noContent = { '204': { description: 'Done.' } };
const body = (name: string) => ({ required: true, ...json(ref(name)) });
const idParam = (what: string) => ({ name: 'id', in: 'path', required: true, description: `The ${what} id.`, schema: str });
const query = (name: string, schema: Json, description: string) => ({ name, in: 'query', required: false, description, schema });

type Op = { summary: string; description?: string; tags: string[]; write?: boolean; parameters?: Json[]; requestBody?: Json; responses: Json };
const op = ({ write, ...o }: Op) => ({
  ...o,
  ...(write ? { 'x-requires-scope': 'write' } : {}),
  responses: {
    ...o.responses,
    '400': { description: 'The input was invalid; `fields` says which parts.', ...json(ref('Error')) },
    '401': { description: 'Missing, wrong, expired or revoked token.', ...json(ref('Error')) },
    '403': { description: write ? 'The token can only read.' : 'Tokens can’t do this.', ...json(ref('Error')) },
    '404': { description: 'Not found, or not yours.', ...json(ref('Error')) },
    '429': { description: 'The token went over its requests-a-minute limit. Wait the seconds in `Retry-After`.', ...json(ref('Error')) },
  },
});

const paths: Json = {
  '/auth/me': {
    get: op({
      tags: ['Account'],
      summary: 'Who the token belongs to',
      description: 'Your profile and preferences, such as `settings.weekStart` (0 = Monday … 6 = Sunday). Read only.',
      responses: ok('The signed-in person.', obj({ user: obj({ id: str, username: str, displayName: str, role: str, settings: { type: 'object' } }, ['id', 'username', 'displayName']) })),
    }),
  },

  '/exercises': {
    get: op({
      tags: ['Exercises'],
      summary: 'Search the exercise library',
      description: 'The shared library plus your own exercises.',
      parameters: [
        query('q', str, 'Words in the name.'),
        query('muscle', str, 'A muscle, from /exercises/facets.'),
        query('equipment', str, 'A piece of equipment, from /exercises/facets.'),
        query('custom', { type: 'string', enum: ['1', 'true'] }, 'Only your own exercises.'),
        query('limit', { ...int, minimum: 1, maximum: 200, default: 50 }, 'Page size.'),
        query('offset', { ...int, minimum: 0, default: 0 }, 'Skip this many.'),
      ],
      responses: ok('Matching exercises.', obj({ exercises: arr(ref('Exercise')), total: int })),
    }),
    post: op({
      tags: ['Exercises'],
      write: true,
      summary: 'Create your own exercise',
      requestBody: body('ExerciseInput'),
      responses: ok('Created.', obj({ exercise: ref('Exercise') }), '201'),
    }),
  },
  '/exercises/facets': {
    get: op({ tags: ['Exercises'], summary: 'Muscles and equipment to filter by', responses: ok('Filter values.', obj({ muscles: arr(str), equipment: arr(str) })) }),
  },
  '/exercises/{id}': {
    parameters: [idParam('exercise')],
    get: op({ tags: ['Exercises'], summary: 'Get an exercise', responses: ok('The exercise.', obj({ exercise: ref('Exercise'), archived: { type: 'boolean' } })) }),
    put: op({
      tags: ['Exercises'],
      write: true,
      summary: 'Replace one of your own exercises',
      description: 'Library exercises can’t be changed.',
      requestBody: body('ExerciseInput'),
      responses: ok('Saved.', obj({ exercise: ref('Exercise') })),
    }),
    delete: op({
      tags: ['Exercises'],
      write: true,
      summary: 'Remove one of your own exercises',
      description: 'It stays in past sessions and workouts that use it.',
      responses: noContent,
    }),
  },

  '/workouts': {
    get: op({ tags: ['Workouts'], summary: 'List your workouts', responses: ok('Your workouts.', obj({ workouts: arr(ref('WorkoutSummary')) })) }),
    post: op({
      tags: ['Workouts'],
      write: true,
      summary: 'Create a workout',
      description:
        'Items run in order. Each item is an exercise step, a rest, or a superset (steps repeated for `rounds`). Every item needs an `id` that is unique within the workout; any short string works. Weights are in kg; a dumbbell weight is for one dumbbell.',
      requestBody: body('WorkoutInput'),
      responses: ok('Created.', ref('WorkoutWithExercises'), '201'),
    }),
  },
  '/workouts/{id}': {
    parameters: [idParam('workout')],
    get: op({ tags: ['Workouts'], summary: 'Get a workout', responses: ok('The workout and its exercises.', ref('WorkoutWithExercises')) }),
    put: op({ tags: ['Workouts'], write: true, summary: 'Replace a workout', requestBody: body('WorkoutInput'), responses: ok('Saved.', ref('WorkoutWithExercises')) }),
    delete: op({ tags: ['Workouts'], write: true, summary: 'Delete a workout', description: 'Past sessions keep their copy.', responses: noContent }),
  },
  '/workouts/{id}/duplicate': {
    parameters: [idParam('workout')],
    post: op({ tags: ['Workouts'], write: true, summary: 'Copy a workout', responses: ok('The copy.', ref('WorkoutWithExercises'), '201') }),
  },
  '/workouts/{id}/targets': {
    parameters: [idParam('workout')],
    post: op({
      tags: ['Workouts'],
      write: true,
      summary: 'Change targets of some steps',
      description: 'Updates reps, weight or duration of exercise steps by item id, leaving the rest of the workout alone.',
      requestBody: body('TargetUpdates'),
      responses: ok('Saved.', obj({ applied: int, workout: ref('Workout') })),
    }),
  },

  '/routines': {
    get: op({ tags: ['Routines'], summary: 'List your routines', responses: ok('Your routines.', obj({ routines: arr(ref('Routine')) })) }),
    post: op({
      tags: ['Routines'],
      write: true,
      summary: 'Create a routine',
      description: '`repeat` cycles through the entries, `once` ends after the last, `weekly` puts each entry on a weekday (0 = Monday … 6 = Sunday).',
      requestBody: body('RoutineInput'),
      responses: ok('Created.', obj({ routine: ref('Routine') }), '201'),
    }),
  },
  '/routines/{id}': {
    parameters: [idParam('routine')],
    get: op({ tags: ['Routines'], summary: 'Get a routine', responses: ok('The routine.', obj({ routine: ref('Routine') })) }),
    put: op({ tags: ['Routines'], write: true, summary: 'Replace a routine', requestBody: body('RoutineInput'), responses: ok('Saved.', obj({ routine: ref('Routine') })) }),
    patch: op({
      tags: ['Routines'],
      write: true,
      summary: 'Pause or resume a routine',
      requestBody: { required: true, ...json(fromZod(routineActiveSchema)) },
      responses: ok('Saved.', obj({ routine: ref('Routine') })),
    }),
    delete: op({ tags: ['Routines'], write: true, summary: 'Delete a routine', responses: noContent }),
  },
  '/routines/{id}/restart': {
    parameters: [idParam('routine')],
    post: op({ tags: ['Routines'], write: true, summary: 'Reset a routine’s progress', responses: ok('Saved.', obj({ routine: ref('Routine') })) }),
  },

  '/sessions': {
    get: op({
      tags: ['Sessions'],
      summary: 'List past sessions, newest first',
      parameters: [query('limit', { ...int, minimum: 1, maximum: 100, default: 20 }, 'Page size.'), query('before', date, 'Only sessions started before this time.')],
      responses: ok('Sessions.', obj({ sessions: arr(ref('SessionSummary')) })),
    }),
  },
  '/sessions/{id}': {
    parameters: [idParam('session')],
    get: op({ tags: ['Sessions'], summary: 'Get a session with every set', responses: ok('The session.', obj({ session: ref('SessionDetail') })) }),
    put: op({
      tags: ['Sessions'],
      write: true,
      summary: 'Log or replace a session',
      description:
        'You choose the id (a UUID), so retrying is safe. Times are epoch milliseconds. `items` and `exercises` are a copy of the workout as it was done, so later edits never rewrite history.',
      requestBody: body('SessionUpload'),
      responses: ok('Saved.', obj({ session: ref('SessionDetail') })),
    }),
    delete: op({ tags: ['Sessions'], write: true, summary: 'Delete a session', responses: noContent }),
  },

  '/stats/sessions': {
    get: op({
      tags: ['Stats'],
      summary: 'When you trained',
      parameters: [query('days', { ...int, minimum: 1, maximum: 1100, default: 400 }, 'How far back.')],
      responses: ok('Session times.', obj({ sessions: arr(obj({ startedAt: date, durationMs: int })) })),
    }),
  },
  '/stats/exercises': {
    get: op({ tags: ['Stats'], summary: 'Every exercise you’ve done, with your bests', responses: ok('Exercises.', obj({ exercises: arr(ref('ExerciseStat')) })) }),
  },
  '/stats/exercises/{id}': {
    parameters: [idParam('exercise')],
    get: op({
      tags: ['Stats'],
      summary: 'Your history with one exercise, oldest first',
      responses: ok('History.', obj({ exerciseId: str, name: str, entries: arr(ref('ExerciseHistoryEntry')) })),
    }),
  },
  '/stats/bests': {
    get: op({
      tags: ['Stats'],
      summary: 'Bests for several exercises',
      parameters: [
        { name: 'ids', in: 'query', required: true, description: 'Exercise ids, comma separated (up to 100).', schema: str },
        query('exclude', str, 'Leave this session out.'),
      ],
      responses: ok('Bests by exercise id.', obj({ bests: { type: 'object', additionalProperties: ref('Bests') } })),
    }),
  },
};

export function openApiDocument(): Json {
  return {
    openapi: '3.1.0',
    info: {
      title: 'setryx API',
      version: '1',
      description:
        'Your own training data: exercises, workouts, routines, sessions and stats. Authenticate with a personal API token from Settings → API and AI agents, sent as `Authorization: Bearer <token>`. A read-only token can use every GET; a read and write token can also create, change and delete. Tokens can’t sign in, change account or server settings, or manage other tokens. Each token may make a set number of requests a minute (the server’s admin chooses it); responses carry `RateLimit-Limit` and `RateLimit-Remaining`, and a 429 carries `Retry-After`.',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ token: [] }],
    components: { securitySchemes: { token: { type: 'http', scheme: 'bearer', description: 'A personal API token (starts with setryx_).' } }, schemas },
    paths,
  };
}
