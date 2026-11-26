import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type ApiTokenScope,
  type Exercise,
  type ExerciseHistoryEntry,
  type PublicUser,
  type Routine,
  type RoutineStatus,
  type SessionDetail,
  type SessionSummary,
  type Workout,
  type WorkoutItem,
  type WorkoutSummary,
  WEEKDAYS,
  bestMatches,
  bestsOf,
  dailyStreak,
  flattenWorkout,
  recordTimeline,
  routineContextFor,
  routineStatus,
  sameExerciseName,
  weeklyStats,
} from '@setryx/shared';
import type { DB } from '../db.ts';
import { listAllVisible } from '../exercises.ts';

// The MCP tools. Every read and change goes through the REST API with the
// caller's own token (ctx.api), so tokens, checks and per-person data work
// exactly as they do for the API. The only direct database read is the
// caller's visible exercise list, used to turn exercise names into ids.

export class ToolError extends Error {}

export type Ctx = {
  db: DB;
  userId: string;
  scope: ApiTokenScope;
  /** Calls /api/v1<path> as the token's owner. Throws ToolError with the API's message on failure. */
  api: <T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<T>;
};

type Tool = {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  /** Changes data: hidden from read-only tokens. */
  write?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  run: (ctx: Ctx, args: any) => Promise<unknown>;
};

// ── Small helpers ──

const shortId = () => randomBytes(5).toString('base64url').replace(/[-_]/g, 'x');
const dropNulls = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '')) as Partial<T>;
const enc = encodeURIComponent;

function dayIndex(day: string): number {
  const d = day.trim().toLowerCase();
  const i = WEEKDAYS.findIndex((w) => w.toLowerCase() === d || w.toLowerCase().slice(0, 3) === d.slice(0, 3));
  if (i < 0 || d.length < 3) throw new ToolError(`“${day}” isn’t a day of the week. Use Monday to Sunday.`);
  return i;
}

/** Letter-level similarity (0..1), so typos like “Uper A” still find “Upper A”. */
function spelling(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - row[y.length]! / Math.max(x.length, y.length, 1);
}

const didYouMean = (what: string, ref: string, options: { name: string }[]) => {
  const byWords = new Map(bestMatches(ref, options, 10, 0.35).map((m) => [m.item.name, m.score]));
  const close = options
    .map((o) => ({ name: o.name, score: Math.max(byWords.get(o.name) ?? 0, spelling(ref, o.name)) }))
    .filter((m) => m.score >= 0.6 || byWords.has(m.name))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((m) => m.name);
  return new ToolError(`No ${what} called “${ref}”.${close.length ? ` Did you mean: ${close.join(', ')}?` : ''}`);
};

/** Resolves exercise names or ids among the caller's visible exercises (library plus their own). */
function exerciseResolver(ctx: Ctx) {
  let visible: Exercise[] | null = null;
  const all = () => (visible ??= listAllVisible(ctx.db, ctx.userId));
  return (ref: string): Exercise => {
    const list = all();
    const byId = list.find((e) => e.id === ref);
    if (byId) return byId;
    const lower = ref.trim().toLowerCase();
    let hits = list.filter((e) => e.name.toLowerCase() === lower);
    if (!hits.length) hits = list.filter((e) => sameExerciseName(e.name, ref));
    if (hits.length > 1) hits = hits.filter((e) => e.isCustom).length === 1 ? hits.filter((e) => e.isCustom) : hits;
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) throw new ToolError(`More than one exercise is called “${ref}”. Use its id: ${hits.map((h) => `${h.name} (${h.id})`).join(', ')}.`);
    throw didYouMean('exercise', ref, list);
  };
}

async function findWorkout(ctx: Ctx, ref: string): Promise<WorkoutSummary> {
  const { workouts } = await ctx.api<{ workouts: WorkoutSummary[] }>('GET', '/workouts');
  const hit = workouts.find((w) => w.id === ref) ?? workouts.find((w) => w.name.toLowerCase() === ref.trim().toLowerCase());
  if (!hit) throw didYouMean('workout', ref, workouts);
  return hit;
}

async function findRoutine(ctx: Ctx, ref: string): Promise<Routine> {
  const { routines } = await ctx.api<{ routines: Routine[] }>('GET', '/routines');
  const hit = routines.find((r) => r.id === ref) ?? routines.find((r) => r.name.toLowerCase() === ref.trim().toLowerCase());
  if (!hit) throw didYouMean('routine', ref, routines);
  return hit;
}

const weekStartOf = async (ctx: Ctx) => (await ctx.api<{ user: PublicUser }>('GET', '/auth/me')).user.settings.weekStart;

// ── Workouts in a friendlier shape ──
// Agents write exercises by name and don't have to invent step ids. "sets"
// is shorthand for a block repeated that many rounds, which is how setryx
// stores sets.

const text = (max: number) => z.string().trim().max(max);
const exerciseFields = {
  id: z.string().max(64).optional().describe('Keep the step id from get_workout when editing, so history and targets stay linked.'),
  exercise: text(100).min(1).describe('Exercise name (or id).'),
  exerciseId: z.string().max(64).optional().describe('Exact exercise id; wins over the name.'),
  reps: z.number().int().min(1).max(999).optional().describe('Target reps. Give reps or durationS.'),
  durationS: z.number().int().min(1).max(36_000).optional().describe('Target seconds, for timed exercises like planks.'),
  weight: z.number().min(0).max(2000).optional().describe('Kilograms. For dumbbells: the weight of one dumbbell.'),
  tempo: text(20).optional().describe('Like 3-1-1-0.'),
  rir: text(10).optional().describe('Reps in reserve, like 2.'),
  notes: text(2000).optional(),
  equipmentNote: text(200).optional().describe('Like “bench at 30°”.'),
};
const exerciseIn = z.object({
  ...exerciseFields,
  sets: z.number().int().min(1).max(20).optional().describe('Repeat this exercise (and restS) this many times.'),
  restS: z.number().int().min(1).max(3600).optional().describe('Rest after each set, in seconds.'),
});
const blockExerciseIn = z.object(exerciseFields);
const restIn = z.object({ id: z.string().max(64).optional(), rest: z.number().int().min(1).max(3600).describe('Rest in seconds.'), label: text(60).optional() });
const supersetIn = z.object({
  id: z.string().max(64).optional(),
  superset: text(80).describe('A label, like “Chest and back”.'),
  rounds: z.number().int().min(1).max(20),
  items: z.array(z.union([restIn, blockExerciseIn])).min(1).max(50).describe('Steps done in order each round; include rests.'),
});
const itemIn = z.union([supersetIn, restIn, exerciseIn]);
const itemsIn = z.array(itemIn).min(1).max(100).describe('Steps in order: exercises, rests ({rest: seconds}) and supersets ({superset, rounds, items}).');
type ItemIn = z.infer<typeof itemIn>;
type ExerciseIn = z.infer<typeof exerciseIn>;

function toItems(ctx: Ctx, items: ItemIn[]): WorkoutItem[] {
  const resolve = exerciseResolver(ctx);
  const step = (x: z.infer<typeof blockExerciseIn>) => {
    const ex = resolve(x.exerciseId ?? x.exercise);
    if (x.reps == null && x.durationS == null) throw new ToolError(`Give reps or durationS for ${ex.name}.`);
    const timed = x.durationS != null && x.reps == null;
    return {
      kind: 'exercise' as const,
      id: x.id ?? shortId(),
      exerciseId: ex.id,
      targetType: timed ? ('timed' as const) : ('reps' as const),
      targetReps: timed ? null : x.reps!,
      targetDurationS: timed ? x.durationS! : null,
      targetWeight: x.weight ?? null,
      tempo: x.tempo ?? null,
      rir: x.rir ?? null,
      notes: x.notes ?? null,
      equipmentNote: x.equipmentNote ?? null,
    };
  };
  const rest = (x: z.infer<typeof restIn>) => ({ kind: 'rest' as const, id: x.id ?? shortId(), durationS: x.rest, label: x.label ?? null });
  return items.flatMap((it): WorkoutItem[] => {
    if ('superset' in it) return [{ kind: 'superset', id: it.id ?? shortId(), label: it.superset, rounds: it.rounds, items: it.items.map((c) => ('rest' in c ? rest(c) : step(c))) }];
    if ('rest' in it) return [rest(it)];
    const e = it as ExerciseIn;
    const s = step(e);
    const restStep = e.restS ? [{ kind: 'rest' as const, id: shortId(), durationS: e.restS, label: null }] : [];
    if (e.sets && e.sets > 1) {
      return [{ kind: 'superset', id: shortId(), label: resolve(e.exerciseId ?? e.exercise).name, rounds: e.sets, items: [s, ...restStep] }];
    }
    return [s, ...restStep];
  });
}

function fromItems(items: WorkoutItem[], exercises: Record<string, { name: string }>): unknown[] {
  const one = (it: WorkoutItem): unknown => {
    if (it.kind === 'superset') return { id: it.id, superset: it.label, rounds: it.rounds, items: it.items.map(one) };
    if (it.kind === 'rest') return dropNulls({ id: it.id, rest: it.durationS, label: it.label });
    return dropNulls({
      id: it.id,
      exercise: exercises[it.exerciseId]?.name ?? '(deleted exercise)',
      exerciseId: it.exerciseId,
      reps: it.targetType === 'reps' ? it.targetReps : null,
      durationS: it.targetType === 'timed' ? it.targetDurationS : null,
      weight: it.targetWeight,
      tempo: it.tempo,
      rir: it.rir,
      notes: it.notes,
      equipmentNote: it.equipmentNote,
    });
  };
  return items.map(one);
}

const workoutOut = (r: { workout: Workout; exercises: Record<string, Exercise> }) => ({
  id: r.workout.id,
  name: r.workout.name,
  icon: r.workout.icon || undefined,
  notes: r.workout.notes ?? undefined,
  updatedAt: r.workout.updatedAt,
  items: fromItems(r.workout.items, r.exercises),
});

// ── Routines ──

const routineDay = (e: { weekday: number | null }) => (e.weekday == null ? undefined : WEEKDAYS[e.weekday]);

function describeStatus(s: RoutineStatus): Record<string, unknown> {
  switch (s.kind) {
    case 'next':
      return { next: s.entry.workoutName, position: `${s.position} of ${s.total}`, lastDoneAt: s.lastDoneAt ?? undefined };
    case 'complete':
      return { finished: true, finishedAt: s.finishedAt };
    case 'week':
      return {
        today: s.today.map((t) => ({ workout: t.entry.workoutName, done: !!t.doneAt })),
        missedThisWeek: s.missed.map((m) => m.workoutName),
        nextDay: s.upcoming ? { day: WEEKDAYS[s.upcoming.weekday], workouts: s.upcoming.entries.map((e) => e.workoutName) } : undefined,
      };
    default:
      return { empty: 'No workouts in this routine.' };
  }
}

const MODE_TEXT = { repeat: 'rotation (repeats)', once: 'programme (runs once)', weekly: 'weekly plan' } as const;

function routineOut(r: Routine, weekStart: number, full = false) {
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    kind: MODE_TEXT[r.mode],
    active: r.active,
    status: r.active ? describeStatus(routineStatus(r, r.runs, new Date(), weekStart)) : 'paused',
    workouts: r.entries.map((e) => dropNulls({ workout: e.workoutName ?? '(deleted workout)', workoutId: e.workoutId, day: routineDay(e), missing: e.workoutName == null ? true : null })),
    ...(full ? { progressSince: r.startedAt, runsSinceThen: r.runs.slice(0, 20).map((x) => ({ workout: r.entries.find((e) => e.id === x.entryId)?.workoutName, at: x.startedAt })) } : {}),
  };
}

const routineWorkoutsIn = z
  .array(z.object({ workout: text(80).min(1).describe('Workout name or id.'), day: text(10).optional().describe('Weekly routines: Monday to Sunday.') }))
  .min(1)
  .max(50);

/** Builds routine entries, keeping the ids of entries that stay so progress isn't lost. */
async function toEntries(ctx: Ctx, mode: Routine['mode'], wanted: z.infer<typeof routineWorkoutsIn>, existing: Routine['entries'] = []) {
  const { workouts } = await ctx.api<{ workouts: WorkoutSummary[] }>('GET', '/workouts');
  const used = new Set<string>();
  return wanted.map((w) => {
    const hit = workouts.find((x) => x.id === w.workout) ?? workouts.find((x) => x.name.toLowerCase() === w.workout.trim().toLowerCase());
    // A deleted workout can stay if it was already in the routine.
    const keptMissing = !hit ? existing.find((e) => e.workoutId === w.workout && !used.has(e.id)) : undefined;
    if (!hit && !keptMissing) throw didYouMean('workout', w.workout, workouts);
    const workoutId = hit?.id ?? keptMissing!.workoutId;
    if (mode === 'weekly' && !w.day) throw new ToolError(`Weekly routines need a day for every workout; ${hit?.name ?? w.workout} has none.`);
    const weekday = mode === 'weekly' ? dayIndex(w.day!) : null;
    const same =
      existing.find((e) => !used.has(e.id) && e.workoutId === workoutId && e.weekday === weekday) ?? existing.find((e) => !used.has(e.id) && e.workoutId === workoutId);
    const id = same?.id ?? `e${shortId()}`;
    used.add(id);
    return { id, workoutId, weekday };
  });
}

// ── Sessions ──

function sessionOut(s: SessionDetail) {
  const byExercise = new Map<string, string[]>();
  for (const l of s.logs) {
    const name = s.exercises[l.exerciseId]?.name ?? l.exerciseId;
    const set = l.actualDurationS != null && l.actualReps == null ? `${l.actualDurationS} s` : `${l.actualReps ?? 0}`;
    const line = `${set}${l.actualWeight ? ` × ${l.actualWeight} kg` : ''}`;
    byExercise.set(name, [...(byExercise.get(name) ?? []), line]);
  }
  return {
    id: s.id,
    workout: s.workoutName,
    workoutId: s.workoutId ?? undefined,
    startedAt: s.startedAt,
    minutes: Math.round(s.durationMs / 60_000),
    status: s.status,
    notes: s.notes ?? undefined,
    volumeKg: s.volumeKg,
    sets: Object.fromEntries(byExercise),
  };
}

const sessionRow = (s: SessionSummary) => ({ id: s.id, workout: s.workoutName, startedAt: s.startedAt, minutes: Math.round(s.durationMs / 60_000), sets: s.setCount, volumeKg: s.volumeKg, status: s.status });

// ── The tools ──

const ref = (what: string) => text(100).min(1).describe(`${what} name or id.`);

export const TOOLS: Tool[] = [
  // Reading
  {
    name: 'whats_next',
    title: 'What’s next',
    description: 'What to train next according to the active routines: the next workout in a rotation, or today’s and missed workouts in a weekly plan.',
    input: z.object({}),
    async run(ctx) {
      const [weekStart, { routines }] = await Promise.all([weekStartOf(ctx), ctx.api<{ routines: Routine[] }>('GET', '/routines')]);
      if (!routines.length) return { routines: [], note: 'No routines yet. Create one with create_routine.' };
      return {
        today: WEEKDAYS[(new Date().getDay() + 6) % 7],
        active: routines.filter((r) => r.active).map((r) => ({ routine: r.name, kind: MODE_TEXT[r.mode], ...describeStatus(routineStatus(r, r.runs, new Date(), weekStart)) })),
        paused: routines.filter((r) => !r.active).map((r) => r.name),
      };
    },
  },
  {
    name: 'training_summary',
    title: 'Training summary',
    description: 'An overview: streaks, sessions per week, the latest sessions and the most-trained exercises with their bests.',
    input: z.object({ weeks: z.number().int().min(1).max(52).default(8).describe('Weeks of history for the per-week counts.') }),
    async run(ctx, { weeks }) {
      const [weekStart, points, recent, stats] = await Promise.all([
        weekStartOf(ctx),
        ctx.api<{ sessions: { startedAt: string; durationMs: number }[] }>('GET', '/stats/sessions?days=400'),
        ctx.api<{ sessions: SessionSummary[] }>('GET', '/sessions?limit=5'),
        ctx.api<{ exercises: { exerciseId: string; name: string; sessions: number; lastDoneAt: string; bests: object }[] }>('GET', '/stats/exercises'),
      ]);
      const now = new Date();
      const w = weeklyStats(points.sessions, now, weekStart, weeks);
      const d = dailyStreak(points.sessions, now);
      return {
        weekStreak: { current: w.current, best: w.best },
        dayStreak: { current: d.current, best: d.best, trainedToday: d.today },
        weeks: w.weeks.map((x) => ({ weekOf: x.start, sessions: x.sessions, minutes: Math.round(x.durationMs / 60_000) })),
        latestSessions: recent.sessions.map(sessionRow),
        topExercises: [...stats.exercises].sort((a, b) => b.sessions - a.sessions).slice(0, 10).map((e) => ({ exercise: e.name, exerciseId: e.exerciseId, sessions: e.sessions, lastDoneAt: e.lastDoneAt, bests: dropNulls(e.bests) })),
      };
    },
  },
  {
    name: 'search_exercises',
    title: 'Search exercises',
    description: 'Search the exercise library and your own exercises by name, muscle or equipment.',
    input: z.object({
      query: text(100).optional().describe('Words in the name.'),
      muscle: text(60).optional(),
      equipment: text(60).optional(),
      mine: z.boolean().default(false).describe('Only your own exercises.'),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    async run(ctx, a) {
      const q = new URLSearchParams(dropNulls({ q: a.query, muscle: a.muscle, equipment: a.equipment, custom: a.mine ? '1' : null, limit: String(a.limit) }) as Record<string, string>);
      const r = await ctx.api<{ exercises: Exercise[]; total: number }>('GET', `/exercises?${q}`);
      return {
        total: r.total,
        exercises: r.exercises.map((e) => ({ id: e.id, name: e.name, yours: e.isCustom || undefined, type: e.defaultType, muscles: e.primaryMuscles, equipment: e.equipment })),
      };
    },
  },
  {
    name: 'get_exercise',
    title: 'Get an exercise',
    description: 'One exercise with its muscles, equipment and instructions.',
    input: z.object({ exercise: ref('Exercise') }),
    async run(ctx, { exercise }) {
      const ex = exerciseResolver(ctx)(exercise);
      return (await ctx.api<{ exercise: Exercise }>('GET', `/exercises/${enc(ex.id)}`)).exercise;
    },
  },
  {
    name: 'exercise_history',
    title: 'Exercise history',
    description: 'Your sets for one exercise across sessions (newest first), your bests and when you set each record.',
    input: z.object({ exercise: ref('Exercise'), limit: z.number().int().min(1).max(200).default(20).describe('How many sessions to list.') }),
    async run(ctx, { exercise, limit }) {
      const ex = exerciseResolver(ctx)(exercise);
      let h: { name: string; entries: ExerciseHistoryEntry[] };
      try {
        h = await ctx.api('GET', `/stats/exercises/${enc(ex.id)}`);
      } catch {
        return { exercise: ex.name, sessions: 0, note: 'No sessions with this exercise yet.' };
      }
      return {
        exercise: h.name,
        exerciseId: ex.id,
        sessions: h.entries.length,
        bests: dropNulls(bestsOf(h.entries.flatMap((e) => e.sets))),
        records: recordTimeline(h.entries).map((r) => ({ kind: r.kind, value: r.value, previous: r.previous, at: r.startedAt })),
        history: [...h.entries].reverse().slice(0, limit).map((e) => ({ at: e.startedAt, workout: e.workoutName, sets: e.sets.map((s) => dropNulls(s)) })),
      };
    },
  },
  {
    name: 'list_workouts',
    title: 'List workouts',
    description: 'Your workouts with their size and estimated length.',
    input: z.object({}),
    async run(ctx) {
      const { workouts } = await ctx.api<{ workouts: WorkoutSummary[] }>('GET', '/workouts');
      return workouts.map((w) => ({ id: w.id, name: w.name, icon: w.icon || undefined, steps: w.stepCount, minutes: Math.round(w.estimatedS / 60), updatedAt: w.updatedAt }));
    },
  },
  {
    name: 'get_workout',
    title: 'Get a workout',
    description: 'A workout step by step, with exercise names, targets and step ids. The items can be edited and passed back to update_workout.',
    input: z.object({ workout: ref('Workout') }),
    async run(ctx, { workout }) {
      const w = await findWorkout(ctx, workout);
      return workoutOut(await ctx.api('GET', `/workouts/${enc(w.id)}`));
    },
  },
  {
    name: 'list_routines',
    title: 'List routines',
    description: 'Your routines: rotations, one-off programmes and weekly plans, with where each stands.',
    input: z.object({}),
    async run(ctx) {
      const [weekStart, { routines }] = await Promise.all([weekStartOf(ctx), ctx.api<{ routines: Routine[] }>('GET', '/routines')]);
      return routines.map((r) => routineOut(r, weekStart));
    },
  },
  {
    name: 'get_routine',
    title: 'Get a routine',
    description: 'One routine in full: its workouts and days, where it stands, and the sessions done since its progress started. Flags workouts that were deleted.',
    input: z.object({ routine: ref('Routine') }),
    async run(ctx, { routine }) {
      const [weekStart, r] = await Promise.all([weekStartOf(ctx), findRoutine(ctx, routine)]);
      return routineOut(r, weekStart, true);
    },
  },
  {
    name: 'list_sessions',
    title: 'List sessions',
    description: 'Past sessions, newest first.',
    input: z.object({ limit: z.number().int().min(1).max(100).default(10), before: z.string().max(40).optional().describe('Only sessions started before this ISO time, for paging.') }),
    async run(ctx, { limit, before }) {
      const q = new URLSearchParams(dropNulls({ limit: String(limit), before }) as Record<string, string>);
      return (await ctx.api<{ sessions: SessionSummary[] }>('GET', `/sessions?${q}`)).sessions.map(sessionRow);
    },
  },
  {
    name: 'get_session',
    title: 'Get a session',
    description: 'One session with every set, grouped by exercise.',
    input: z.object({ session: z.string().max(64).describe('Session id, from list_sessions.') }),
    async run(ctx, { session }) {
      return sessionOut((await ctx.api<{ session: SessionDetail }>('GET', `/sessions/${enc(session)}`)).session);
    },
  },

  // Exercises
  {
    name: 'create_exercise',
    title: 'Create an exercise',
    description: 'Add your own exercise when the library doesn’t have it. Search first to avoid duplicates.',
    write: true,
    input: z.object({
      name: text(100).min(1),
      type: z.enum(['reps', 'timed']).default('reps').describe('Counted in reps, or held for time.'),
      category: text(40).optional(),
      primaryMuscles: z.array(text(60)).max(20).default([]),
      secondaryMuscles: z.array(text(60)).max(20).default([]),
      equipment: z.array(text(60)).max(20).default([]),
      instructions: z.array(text(1000)).max(30).default([]).describe('One step per entry.'),
    }),
    async run(ctx, a) {
      const { exercise } = await ctx.api<{ exercise: Exercise }>('POST', '/exercises', { ...a, defaultType: a.type, category: a.category ?? null });
      return exercise;
    },
  },
  {
    name: 'update_exercise',
    title: 'Update an exercise',
    description: 'Change one of your own exercises. Fields left out stay as they are. Library exercises can’t be changed.',
    write: true,
    idempotent: true,
    input: z.object({
      exercise: ref('Exercise'),
      name: text(100).min(1).optional(),
      type: z.enum(['reps', 'timed']).optional(),
      category: text(40).nullable().optional(),
      primaryMuscles: z.array(text(60)).max(20).optional(),
      secondaryMuscles: z.array(text(60)).max(20).optional(),
      equipment: z.array(text(60)).max(20).optional(),
      instructions: z.array(text(1000)).max(30).optional(),
    }),
    async run(ctx, { exercise, type, ...changes }) {
      const ex = exerciseResolver(ctx)(exercise);
      if (!ex.isCustom) throw new ToolError(`${ex.name} is a library exercise and can’t be changed. Create your own version with create_exercise.`);
      const body = { name: ex.name, defaultType: type ?? ex.defaultType, category: ex.category, primaryMuscles: ex.primaryMuscles, secondaryMuscles: ex.secondaryMuscles, equipment: ex.equipment, instructions: ex.instructions };
      for (const [k, v] of Object.entries(changes)) if (v !== undefined) (body as Record<string, unknown>)[k] = v;
      return (await ctx.api<{ exercise: Exercise }>('PUT', `/exercises/${enc(ex.id)}`, body)).exercise;
    },
  },
  {
    name: 'delete_exercise',
    title: 'Delete an exercise',
    description: 'Remove one of your own exercises from the library list. Past sessions and workouts that use it keep it.',
    write: true,
    destructive: true,
    input: z.object({ exercise: ref('Exercise') }),
    async run(ctx, { exercise }) {
      const ex = exerciseResolver(ctx)(exercise);
      if (!ex.isCustom) throw new ToolError(`${ex.name} is a library exercise and can’t be removed.`);
      await ctx.api('DELETE', `/exercises/${enc(ex.id)}`);
      return { deleted: ex.name };
    },
  },

  // Workouts
  {
    name: 'create_workout',
    title: 'Create a workout',
    description:
      'Create a workout from steps in order. Exercises are named, with reps or durationS and optional weight (kg; one dumbbell’s weight for dumbbells). Use sets and restS for straight sets, or a superset block to alternate exercises for several rounds. Weight and reps are targets; the player suggests updates after each session.',
    write: true,
    input: z.object({ name: text(80).min(1), icon: text(16).optional().describe('An emoji.'), notes: text(2000).optional(), items: itemsIn }),
    async run(ctx, a) {
      const r = await ctx.api('POST', '/workouts', { name: a.name, icon: a.icon ?? '', notes: a.notes ?? null, items: toItems(ctx, a.items) });
      return workoutOut(r);
    },
  },
  {
    name: 'update_workout',
    title: 'Update a workout',
    description:
      'Rename a workout, change its notes, or replace its steps. To edit steps, get_workout first and pass back the edited items, keeping their ids. For small target changes, update_targets is simpler.',
    write: true,
    idempotent: true,
    input: z.object({ workout: ref('Workout'), name: text(80).min(1).optional(), icon: text(16).optional(), notes: text(2000).nullable().optional(), items: itemsIn.optional() }),
    async run(ctx, a) {
      const w = await findWorkout(ctx, a.workout);
      const cur = await ctx.api<{ workout: Workout }>('GET', `/workouts/${enc(w.id)}`);
      const body = {
        name: a.name ?? cur.workout.name,
        icon: a.icon ?? cur.workout.icon,
        notes: a.notes === undefined ? cur.workout.notes : a.notes,
        items: a.items ? toItems(ctx, a.items) : cur.workout.items,
      };
      return workoutOut(await ctx.api('PUT', `/workouts/${enc(w.id)}`, body));
    },
  },
  {
    name: 'update_targets',
    title: 'Update targets',
    description: 'Change target reps, weight or duration in a workout without resending it. Name an exercise to change every set of it, or give a step id from get_workout to change one.',
    write: true,
    idempotent: true,
    input: z.object({
      workout: ref('Workout'),
      changes: z
        .array(
          z.object({
            exercise: text(100).optional().describe('Change every step of this exercise.'),
            step: z.string().max(64).optional().describe('Or one step id.'),
            reps: z.number().int().min(1).max(999).optional(),
            weight: z.number().min(0).max(2000).nullable().optional().describe('Kilograms; null for no weight.'),
            durationS: z.number().int().min(1).max(36_000).optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
    async run(ctx, { workout, changes }) {
      const w = await findWorkout(ctx, workout);
      const cur = await ctx.api<{ workout: Workout; exercises: Record<string, Exercise> }>('GET', `/workouts/${enc(w.id)}`);
      const steps = flattenWorkout(cur.workout.items).filter((s) => s.kind === 'exercise');
      const resolve = exerciseResolver(ctx);
      const updates = new Map<string, { itemId: string; targetReps?: number; targetWeight?: number | null; targetDurationS?: number }>();
      for (const c of changes) {
        if (!c.exercise && !c.step) throw new ToolError('Each change needs an exercise or a step id.');
        const exId = c.exercise ? resolve(c.exercise).id : null;
        const hits = steps.filter((s) => (c.step ? s.id === c.step : s.kind === 'exercise' && s.exerciseId === exId));
        if (!hits.length) throw new ToolError(`${c.step ? `No step ${c.step}` : `${c.exercise} isn’t`} in ${cur.workout.name}.`);
        for (const s of hits) {
          const u = updates.get(s.id) ?? { itemId: s.id };
          if (c.reps !== undefined) u.targetReps = c.reps;
          if (c.weight !== undefined) u.targetWeight = c.weight;
          if (c.durationS !== undefined) u.targetDurationS = c.durationS;
          updates.set(s.id, u);
        }
      }
      const r = await ctx.api<{ applied: number; workout: Workout }>('POST', `/workouts/${enc(w.id)}/targets`, { updates: [...updates.values()] });
      return { changedSteps: r.applied, workout: workoutOut({ workout: r.workout, exercises: cur.exercises }) };
    },
  },
  {
    name: 'duplicate_workout',
    title: 'Duplicate a workout',
    description: 'Copy a workout, for example to make a variation.',
    write: true,
    input: z.object({ workout: ref('Workout'), name: text(80).min(1).optional().describe('Name for the copy; defaults to “<name> (copy)”.') }),
    async run(ctx, { workout, name }) {
      const w = await findWorkout(ctx, workout);
      let r = await ctx.api<{ workout: Workout; exercises: Record<string, Exercise> }>('POST', `/workouts/${enc(w.id)}/duplicate`);
      if (name) r = await ctx.api('PUT', `/workouts/${enc(r.workout.id)}`, { name, icon: r.workout.icon, notes: r.workout.notes, items: r.workout.items });
      return workoutOut(r);
    },
  },
  {
    name: 'delete_workout',
    title: 'Delete a workout',
    description: 'Delete a workout. Past sessions keep their copy of it; routines show it as missing.',
    write: true,
    destructive: true,
    input: z.object({ workout: ref('Workout') }),
    async run(ctx, { workout }) {
      const w = await findWorkout(ctx, workout);
      await ctx.api('DELETE', `/workouts/${enc(w.id)}`);
      return { deleted: w.name };
    },
  },

  // Routines
  {
    name: 'create_routine',
    title: 'Create a routine',
    description:
      'Create a routine from existing workouts. mode “repeat” cycles through them in order (a rotation), “once” runs through them once (a programme), “weekly” puts each on a day of the week.',
    write: true,
    input: z.object({ name: text(80).min(1), mode: z.enum(['repeat', 'once', 'weekly']), workouts: routineWorkoutsIn, active: z.boolean().default(true) }),
    async run(ctx, a) {
      const entries = await toEntries(ctx, a.mode, a.workouts);
      const { routine } = await ctx.api<{ routine: Routine }>('POST', '/routines', { name: a.name, mode: a.mode, active: a.active, entries });
      return routineOut(routine, await weekStartOf(ctx));
    },
  },
  {
    name: 'edit_routine',
    title: 'Edit a routine',
    description:
      'Rename a routine, change its mode, or give its new list of workouts. Workouts that stay keep their place, so a rotation carries on where it was; only new ones start fresh.',
    write: true,
    idempotent: true,
    input: z.object({ routine: ref('Routine'), name: text(80).min(1).optional(), mode: z.enum(['repeat', 'once', 'weekly']).optional(), workouts: routineWorkoutsIn.optional() }),
    async run(ctx, a) {
      const r = await findRoutine(ctx, a.routine);
      const mode = a.mode ?? r.mode;
      const wanted = a.workouts ?? r.entries.map((e) => ({ workout: e.workoutId, day: routineDay(e) }));
      if (mode === 'weekly' && !a.workouts && r.mode !== 'weekly') throw new ToolError('Switching to a weekly plan needs a day for every workout: pass workouts with days.');
      const entries = await toEntries(ctx, mode, wanted, r.entries);
      const { routine } = await ctx.api<{ routine: Routine }>('PUT', `/routines/${enc(r.id)}`, { name: a.name ?? r.name, mode, active: r.active, entries });
      return routineOut(routine, await weekStartOf(ctx));
    },
  },
  {
    name: 'pause_routine',
    title: 'Pause a routine',
    description: 'Pause a routine, for a holiday or a break. It leaves Today but keeps its progress.',
    write: true,
    idempotent: true,
    input: z.object({ routine: ref('Routine') }),
    async run(ctx, { routine }) {
      const r = await findRoutine(ctx, routine);
      await ctx.api('PATCH', `/routines/${enc(r.id)}`, { active: false });
      return { paused: r.name };
    },
  },
  {
    name: 'resume_routine',
    title: 'Resume a routine',
    description: 'Resume a paused routine where it left off.',
    write: true,
    idempotent: true,
    input: z.object({ routine: ref('Routine') }),
    async run(ctx, { routine }) {
      const r = await findRoutine(ctx, routine);
      const { routine: next } = await ctx.api<{ routine: Routine }>('PATCH', `/routines/${enc(r.id)}`, { active: true });
      return routineOut(next, await weekStartOf(ctx));
    },
  },
  {
    name: 'reset_routine_progress',
    title: 'Reset routine progress',
    description: 'Start a routine over from its first workout. Past sessions stay in your history; they just stop counting towards this routine.',
    write: true,
    destructive: true,
    input: z.object({ routine: ref('Routine') }),
    async run(ctx, { routine }) {
      const r = await findRoutine(ctx, routine);
      const { routine: next } = await ctx.api<{ routine: Routine }>('POST', `/routines/${enc(r.id)}/restart`);
      return routineOut(next, await weekStartOf(ctx));
    },
  },
  {
    name: 'delete_routine',
    title: 'Delete a routine',
    description: 'Delete a routine. Its workouts and the sessions done with it stay.',
    write: true,
    destructive: true,
    input: z.object({ routine: ref('Routine') }),
    async run(ctx, { routine }) {
      const r = await findRoutine(ctx, routine);
      await ctx.api('DELETE', `/routines/${enc(r.id)}`);
      return { deleted: r.name };
    },
  },

  // Sessions
  {
    name: 'log_session',
    title: 'Log a session',
    description:
      'Record a workout done without the app, set by set. With a workout, sets are matched to its steps and the session counts towards any routine waiting on that workout. Without one, give a name. Weights in kg.',
    write: true,
    input: z.object({
      workout: text(100).optional().describe('Workout name or id, if it followed one.'),
      name: text(80).optional().describe('Name for the session when there’s no workout.'),
      startedAt: z.string().max(40).optional().describe('ISO time it started; defaults to durationMinutes ago.'),
      durationMinutes: z.number().int().min(1).max(600),
      sets: z
        .array(z.object({ exercise: text(100).min(1), reps: z.number().int().min(0).max(999).optional(), weight: z.number().min(0).max(2000).optional(), durationS: z.number().int().min(0).max(36_000).optional() }))
        .min(1)
        .max(500)
        .describe('Every set done, in order.'),
      notes: text(2000).optional(),
      endedEarly: z.boolean().default(false),
    }),
    async run(ctx, a) {
      const resolve = exerciseResolver(ctx);
      const durationMs = a.durationMinutes * 60_000;
      const started = a.startedAt ? Date.parse(a.startedAt) : Date.now() - durationMs;
      if (Number.isNaN(started)) throw new ToolError('startedAt isn’t a valid ISO time.');
      if (started + durationMs > Date.now() + 5 * 60_000) throw new ToolError('That session would end in the future.');

      let workout: Workout | null = null;
      let snapshotExercises: Record<string, Exercise> = {};
      if (a.workout) {
        const w = await findWorkout(ctx, a.workout);
        const r = await ctx.api<{ workout: Workout; exercises: Record<string, Exercise> }>('GET', `/workouts/${enc(w.id)}`);
        workout = r.workout;
        snapshotExercises = r.exercises;
      } else if (!a.name) throw new ToolError('Give a workout, or a name for the session.');

      const steps = workout ? flattenWorkout(workout.items) : [];
      const usedSteps = new Set<number>();
      let extra = steps.length;
      const logs = a.sets.map((s: { exercise: string; reps?: number; weight?: number; durationS?: number }, i: number) => {
        const ex = resolve(s.exercise);
        snapshotExercises[ex.id] ??= ex;
        if (s.reps == null && s.durationS == null) throw new ToolError(`Give reps or durationS for each ${ex.name} set.`);
        const idx = steps.findIndex((st, j) => !usedSteps.has(j) && st.kind === 'exercise' && st.exerciseId === ex.id);
        const step = idx >= 0 ? steps[idx]! : null;
        if (idx >= 0) usedSteps.add(idx);
        const planned = step && step.kind === 'exercise' ? step : null;
        return {
          stepIndex: idx >= 0 ? idx : extra++,
          itemId: step?.id ?? `logged-${i + 1}`,
          exerciseId: ex.id,
          round: step?.superset?.round ?? null,
          plannedReps: planned?.targetReps ?? null,
          actualReps: s.reps ?? null,
          plannedWeight: planned?.targetWeight ?? null,
          actualWeight: s.weight ?? null,
          plannedDurationS: planned?.targetDurationS ?? null,
          actualDurationS: s.durationS ?? null,
          completedAt: Math.round(started + ((i + 1) * durationMs) / a.sets.length),
        };
      });

      let routine: { routineId: string; entryId: string } | null = null;
      let routineName: string | undefined;
      if (workout) {
        const [weekStart, { routines }] = await Promise.all([weekStartOf(ctx), ctx.api<{ routines: Routine[] }>('GET', '/routines')]);
        // Only routines whose current progress began before this session can count it.
        const counting = routines.filter((r) => Date.parse(r.startedAt) <= started);
        routine = routineContextFor(workout.id, counting, new Date(started), [], weekStart);
        routineName = routines.find((r) => r.id === routine?.routineId)?.name;
      }

      const id = randomUUID();
      const { session } = await ctx.api<{ session: SessionDetail }>('PUT', `/sessions/${id}`, {
        workoutId: workout?.id ?? null,
        routineId: routine?.routineId ?? null,
        routineEntryId: routine?.entryId ?? null,
        workoutName: workout?.name ?? a.name,
        icon: workout?.icon ?? '',
        startedAt: started,
        endedAt: started + durationMs,
        durationMs,
        status: a.endedEarly ? 'ended_early' : 'completed',
        notes: a.notes ?? null,
        items: workout?.items ?? [],
        exercises: Object.fromEntries(Object.entries(snapshotExercises).map(([k, e]) => [k, { name: e.name, equipment: e.equipment, instructions: e.instructions }])),
        logs,
      });
      return { ...sessionOut(session), countedForRoutine: routineName };
    },
  },
];

export const toolsFor = (scope: ApiTokenScope) => TOOLS.filter((t) => scope === 'write' || !t.write);

/** The tools/list entry for a tool. */
export function describeTool(t: Tool) {
  const { $schema: _s, ...inputSchema } = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema,
    annotations: { title: t.title, readOnlyHint: !t.write, destructiveHint: !!t.destructive, idempotentHint: !t.write || !!t.idempotent, openWorldHint: false },
  };
}

export type { Tool };
