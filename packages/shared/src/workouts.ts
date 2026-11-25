import { z } from 'zod';

// ── Exercises (library) ───────────────────────────────────

export const exerciseTypeSchema = z.enum(['reps', 'timed']);
export type ExerciseType = z.infer<typeof exerciseTypeSchema>;

export const exerciseSchema = z.object({
  id: z.string(),
  name: z.string(),
  isCustom: z.boolean(),
  category: z.string().nullable(),
  defaultType: exerciseTypeSchema,
  primaryMuscles: z.array(z.string()),
  secondaryMuscles: z.array(z.string()),
  equipment: z.array(z.string()),
  instructions: z.array(z.string()),
  images: z.array(z.string()),
});
export type Exercise = z.infer<typeof exerciseSchema>;

const shortList = z.array(z.string().trim().min(1).max(60)).max(20);

export const exerciseInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(100, 'Use at most 100 characters.'),
  defaultType: exerciseTypeSchema.default('reps'),
  category: z.string().trim().max(40).nullable().default(null),
  primaryMuscles: shortList.default([]),
  secondaryMuscles: shortList.default([]),
  equipment: shortList.default([]),
  instructions: z.array(z.string().trim().min(1).max(1000)).max(30).default([]),
});
export type ExerciseInput = z.input<typeof exerciseInputSchema>;

// ── Workouts ──────────────────────────────────────────────

const itemId = z.string().min(1).max(64);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

export const exerciseStepSchema = z
  .object({
    kind: z.literal('exercise'),
    id: itemId,
    exerciseId: z.string().min(1).max(64),
    targetType: exerciseTypeSchema,
    targetReps: z.number().int().min(1).max(999).nullable(),
    targetDurationS: z.number().int().min(1).max(36_000).nullable(),
    targetWeight: z.number().min(0).max(2000).nullable(),
    tempo: optText(20),
    rir: optText(10),
    notes: optText(2000),
    equipmentNote: optText(200),
  })
  .superRefine((s, ctx) => {
    if (s.targetType === 'reps' && s.targetReps == null) ctx.addIssue({ code: 'custom', path: ['targetReps'], message: 'Enter the number of reps.' });
    if (s.targetType === 'timed' && s.targetDurationS == null) ctx.addIssue({ code: 'custom', path: ['targetDurationS'], message: 'Enter a duration.' });
  });
export type ExerciseStep = z.infer<typeof exerciseStepSchema>;

export const restStepSchema = z.object({
  kind: z.literal('rest'),
  id: itemId,
  durationS: z.number().int().min(1).max(3600),
  label: optText(60),
});
export type RestStep = z.infer<typeof restStepSchema>;

export const blockStepSchema = z.union([exerciseStepSchema, restStepSchema]);
export type BlockStep = ExerciseStep | RestStep;

export const supersetSchema = z.object({
  kind: z.literal('superset'),
  id: itemId,
  label: z.string().trim().max(80),
  rounds: z.number().int().min(1).max(20),
  items: z.array(blockStepSchema).min(1, 'A superset needs at least one step.').max(50),
});
export type Superset = z.infer<typeof supersetSchema>;

export const workoutItemSchema = z.union([exerciseStepSchema, restStepSchema, supersetSchema]);
export type WorkoutItem = ExerciseStep | RestStep | Superset;

export const workoutInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the workout a name.').max(80, 'Use at most 80 characters.'),
    icon: z.string().trim().max(16).default(''),
    notes: optText(2000).default(null),
    items: z.array(workoutItemSchema).min(1, 'Add at least one exercise.').max(100),
  })
  .superRefine((w, ctx) => {
    const seen = new Set<string>();
    const check = (id: string, path: (string | number)[]) => {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path, message: 'Duplicate step id.' });
      seen.add(id);
    };
    w.items.forEach((it, i) => {
      check(it.id, ['items', i, 'id']);
      if (it.kind === 'superset') it.items.forEach((s, j) => check(s.id, ['items', i, 'items', j, 'id']));
    });
    const hasExercise = w.items.some((it) => it.kind === 'exercise' || (it.kind === 'superset' && it.items.some((s) => s.kind === 'exercise')));
    if (!hasExercise) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Add at least one exercise.' });
  });
export type WorkoutInput = z.input<typeof workoutInputSchema>;

export type Workout = {
  id: string;
  name: string;
  icon: string;
  notes: string | null;
  items: WorkoutItem[];
  createdAt: string;
  updatedAt: string;
};

export type WorkoutSummary = {
  id: string;
  name: string;
  icon: string;
  blockCount: number;
  supersetCount: number;
  stepCount: number;
  estimatedS: number;
  updatedAt: string;
};

/** A workout plus the library entries its steps refer to, so a client can render names. */
export type WorkoutWithExercises = { workout: Workout; exercises: Record<string, Exercise> };

// ── Routine import ──────────────────────────────────────────

export const importChoiceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('library'), id: z.string().min(1).max(64) }),
  z.object({ type: z.literal('existing'), id: z.string().min(1).max(64) }),
  z.object({ type: z.literal('custom') }),
]);
export type ImportChoice = z.infer<typeof importChoiceSchema>;

export const routineImportPreviewRequestSchema = z.object({ data: z.unknown() });
export const routineImportRequestSchema = z.object({
  data: z.unknown(),
  choices: z.record(z.string(), importChoiceSchema),
});
export type RoutineImportRequest = z.infer<typeof routineImportRequestSchema>;

export type RoutineImportPreviewExercise = {
  key: string;
  name: string;
  defaultType: ExerciseType;
  equipment: string[];
  weights: number[];
  /** One of your own exercises with the same name, reused automatically. */
  existing: { id: string; name: string } | null;
  suggestions: { id: string; name: string; score: number }[];
  defaultChoice: ImportChoice;
};

export type RoutineImportPreview = {
  workouts: { name: string; icon: string; blockCount: number; stepCount: number; estimatedS: number; existingName: boolean }[];
  exercises: RoutineImportPreviewExercise[];
};

// ── Sessions (performed workouts) ─────────────────────────

export const setLogSchema = z.object({
  stepIndex: z.number().int().min(0).max(5000),
  itemId: z.string().min(1).max(64),
  exerciseId: z.string().min(1).max(64),
  round: z.number().int().min(1).max(20).nullable(),
  plannedReps: z.number().int().min(0).max(999).nullable(),
  actualReps: z.number().int().min(0).max(999).nullable(),
  plannedWeight: z.number().min(0).max(2000).nullable(),
  actualWeight: z.number().min(0).max(2000).nullable(),
  plannedDurationS: z.number().int().min(0).max(36_000).nullable(),
  actualDurationS: z.number().int().min(0).max(36_000).nullable(),
  completedAt: z.number().int().min(0),
});

export const sessionStatusSchema = z.enum(['completed', 'ended_early']);

/** What a device uploads once a session is reviewed. Times are epoch milliseconds. */
export const sessionUploadSchema = z.object({
  workoutId: z.string().max(64).nullable(),
  workoutName: z.string().trim().min(1).max(80),
  icon: z.string().max(16).default(''),
  startedAt: z.number().int().min(0),
  endedAt: z.number().int().min(0),
  durationMs: z.number().int().min(0).max(24 * 3_600_000),
  status: sessionStatusSchema,
  notes: z.string().trim().max(2000).nullable().default(null),
  // The workout as it was when performed (kept so later edits never rewrite history).
  items: z.array(z.unknown()).max(200),
  exercises: z.record(z.string(), z.object({ name: z.string(), equipment: z.array(z.string()), instructions: z.array(z.string()) })),
  logs: z.array(setLogSchema).max(2000),
});
export type SessionUpload = z.input<typeof sessionUploadSchema>;

export type SessionSummary = {
  id: string;
  workoutId: string | null;
  workoutName: string;
  icon: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: z.infer<typeof sessionStatusSchema>;
  setCount: number;
  volumeKg: number;
};

export type SessionDetail = SessionSummary & {
  notes: string | null;
  items: WorkoutItem[];
  exercises: Record<string, { name: string; equipment: string[]; instructions: string[] }>;
  logs: z.infer<typeof setLogSchema>[];
};

export const targetUpdatesSchema = z.object({
  updates: z
    .array(
      z.object({
        itemId: z.string().min(1).max(64),
        targetReps: z.number().int().min(1).max(999).nullable().optional(),
        targetWeight: z.number().min(0).max(2000).nullable().optional(),
        targetDurationS: z.number().int().min(1).max(36_000).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type TargetUpdates = z.infer<typeof targetUpdatesSchema>;
