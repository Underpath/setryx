// Reads routine exports from the earlier single-file tracker (JSON with a "routines" array).
import { z } from 'zod';
import type { ExerciseType, RestStep, WorkoutItem } from './workouts.ts';

// ── Loose input schema (mirrors what the old tracker accepted) ──
// Text is cut to a sensible length and lists to a sensible count before any
// parsing, so a crafted file can't make the matching below slow.
export const IMPORT_LIMITS = { routines: 50, stepsPerRoutine: 200, stepsInAll: 1000 };
const text = (max: number) => z.string().transform((s) => s.slice(0, max));
const short = z.union([z.number(), text(20)]);
const capped = <T extends z.ZodType>(item: T, max: number) => z.array(item).transform((a) => a.slice(0, max));

const legacyExercise = z
  .object({
    id: text(100).optional(),
    name: text(100),
    desc: text(2000).optional(),
    type: text(20).optional(),
    reps: short.optional(),
    duration: short.optional(),
    tempo: text(40).optional(),
    rir: short.optional(),
    equipment: text(200).optional(),
  })
  .loose();
const legacyItem = legacyExercise.extend({
  kind: text(20).optional(),
  rounds: short.optional(),
  exercises: capped(legacyExercise, 50).optional(),
});
const legacyRoutine = z
  .object({ id: text(100).optional(), name: text(100).optional(), icon: text(16).optional(), exercises: capped(legacyItem, IMPORT_LIMITS.stepsPerRoutine) })
  .loose();

/** A workout step that points at an exercise by its import key instead of a library id. */
export type ImportedItem =
  | (Omit<Extract<WorkoutItem, { kind: 'exercise' }>, 'exerciseId'> & { exerciseKey: string })
  | RestStep
  | { kind: 'superset'; id: string; label: string; rounds: number; items: (Exclude<ImportedItem, { kind: 'superset' }>)[] };

export type ImportedWorkout = { name: string; icon: string; items: ImportedItem[] };

export type ImportedExercise = {
  /** Normalised name; identical names across workouts share one exercise. */
  key: string;
  name: string;
  defaultType: ExerciseType;
  equipment: string[];
  /** Weights found in the text, for the confirmation screen. */
  weightsFound: { workout: string; weight: number; source: string }[];
};

export type RoutineParseResult = { workouts: ImportedWorkout[]; exercises: ImportedExercise[] };

const toInt = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const num = (s: string) => Number(s.replace(',', '.'));

/** Steps that were only timers ("Rest", "Transition") become rest steps. */
const REST_NAMES = /^(rest|transition|break|recover(y)?)\b/i;
function isRestLike(e: z.infer<typeof legacyExercise>): boolean {
  return REST_NAMES.test(e.name.trim()) && e.type === 'timed' && !(e.equipment ?? '').trim();
}

/**
 * Finds the planned weight. "Weight: 8 kg per hand" in the description wins
 * (it's what the lifter wrote as the plan); otherwise the first "N kg" in the
 * equipment text. Per-hand weights are kept as written (one dumbbell's weight).
 */
export function parseWeight(desc: string | undefined, equipment: string | undefined): { weight: number; source: string } | null {
  // The lookbehinds start a number only at its first digit, which keeps these linear.
  const fromDesc = /weight:\s*(\d+(?:[.,]\d+)?)\s*kg/i.exec(desc ?? '');
  if (fromDesc) return { weight: num(fromDesc[1]!), source: fromDesc[0] };
  const fromEquip = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*kg/i.exec(equipment ?? '');
  if (fromEquip) return { weight: num(fromEquip[1]!), source: fromEquip[0] };
  return null;
}

/** "Dumbbells 8 kg, Incline bench" → ["Dumbbells", "Incline bench"] */
export function parseEquipment(equipment: string | undefined): string[] {
  return (equipment ?? '')
    .split(',')
    .map((s) => s.replace(/(?<![\d.,])\d+(?:[.,]\d+)?\s*kg\b/gi, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s && s.toLowerCase() !== 'bodyweight');
}

/** Removes the leading "Weight: 8 kg per hand." sentence, which becomes a field. */
export function cleanNotes(desc: string | undefined): string | null {
  const text = (desc ?? '').replace(/^\s*weight:\s*\d+(?:[.,]\d+)?\s*kg[^.]*\.\s*/i, '').trim();
  return text || null;
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Accepts the export wrapper ({ routines: [...] }), a bare array of routines, or a single routine. */
export function parseRoutineExport(data: unknown): RoutineParseResult | null {
  let list: unknown[] | null = null;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object' && Array.isArray((data as { routines?: unknown }).routines)) list = (data as { routines: unknown[] }).routines;
  else if (data && typeof data === 'object' && 'exercises' in data) list = [data];
  if (!list?.length) return null;
  list = list.slice(0, IMPORT_LIMITS.routines);
  let stepsLeft = IMPORT_LIMITS.stepsInAll;

  const exercises = new Map<string, ImportedExercise>();
  let seq = 0;
  const newId = () => `imp-${++seq}`;

  const convertStep = (e: z.infer<typeof legacyExercise>, workoutName: string): Exclude<ImportedItem, { kind: 'superset' }> | null => {
    const name = e.name.trim();
    if (!name || stepsLeft <= 0) return null;
    stepsLeft--;
    if (isRestLike(e)) {
      return { kind: 'rest', id: newId(), durationS: toInt(e.duration, 30, 1, 3600), label: name.toLowerCase() === 'rest' ? null : name };
    }
    const targetType: ExerciseType = e.type === 'timed' ? 'timed' : 'reps';
    const weight = parseWeight(e.desc, e.equipment);
    const key = normalizeName(name);
    let ex = exercises.get(key);
    if (!ex) {
      ex = { key, name, defaultType: targetType, equipment: parseEquipment(e.equipment), weightsFound: [] };
      exercises.set(key, ex);
    }
    if (weight) ex.weightsFound.push({ workout: workoutName, ...weight });
    const rir = e.rir == null || e.rir === '' ? null : String(e.rir);
    return {
      kind: 'exercise',
      id: newId(),
      exerciseKey: key,
      targetType,
      targetReps: targetType === 'reps' ? toInt(e.reps, 10, 1, 999) : null,
      targetDurationS: targetType === 'timed' ? toInt(e.duration, 30, 1, 36_000) : null,
      targetWeight: weight?.weight ?? null,
      tempo: e.tempo?.trim() || null,
      rir,
      notes: cleanNotes(e.desc),
      equipmentNote: e.equipment?.trim() || null,
    };
  };

  const workouts: ImportedWorkout[] = [];
  for (const raw of list) {
    const parsed = legacyRoutine.safeParse(raw);
    if (!parsed.success) continue;
    const r = parsed.data;
    const name = (r.name ?? '').trim() || 'Imported workout';
    const items: ImportedItem[] = [];
    for (const it of r.exercises) {
      if (it.kind === 'superset') {
        const children = (it.exercises ?? []).map((c) => convertStep(c, name)).filter((c) => c !== null);
        if (!children.length) continue;
        items.push({ kind: 'superset', id: newId(), label: (it.name ?? '').trim().slice(0, 80), rounds: toInt(it.rounds, 1, 1, 20), items: children });
      } else {
        const step = convertStep(it, name);
        if (step) items.push(step);
      }
    }
    if (items.length) workouts.push({ name: name.slice(0, 80), icon: (r.icon ?? '').trim().slice(0, 16), items });
  }
  if (!workouts.length) return null;
  return { workouts, exercises: [...exercises.values()] };
}

// ── Matching imported names against the library ──

const STOP = new Set(['the', 'a', 'with', 'and', 'on', 'of', 'to', 'degrees', 'degree']);
const SYNONYMS: Record<string, string> = {
  pullups: 'pull up', pullup: 'pull up', chinups: 'chin up', chinup: 'chin up', situps: 'sit up', pushups: 'push up',
  db: 'dumbbell', dumbbells: 'dumbbell', bb: 'barbell', tricep: 'triceps', bicep: 'biceps', flye: 'fly', flyes: 'fly', flys: 'fly',
};

// Library names are compared over and over, so their word sets are kept.
const tokenCache = new Map<string, Set<string>>();

function tokens(name: string): Set<string> {
  const hit = tokenCache.get(name);
  if (hit) return hit;
  if (tokenCache.size > 5000) tokenCache.clear();
  const set = computeTokens(name.slice(0, 200));
  tokenCache.set(name, set);
  return set;
}

function computeTokens(name: string): Set<string> {
  // [^()] rather than [^)] keeps this linear on runs of "(".
  const words = normalizeName(name.replace(/\([^()]*\)/g, ' '))
    .split(' ')
    .flatMap((w) => (SYNONYMS[w] ?? w).split(' '))
    .map((w) => (w.length > 2 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .filter((w) => w && !STOP.has(w));
  return new Set(words);
}

/** Similarity between 0 and 1 (Dice coefficient over normalised word sets). */
export function nameSimilarity(a: string, b: string): number {
  return similarity(tokens(a), tokens(b));
}

function similarity(ta: Set<string>, tb: Set<string>): number {
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

export function bestMatches<T extends { name: string }>(name: string, candidates: T[], limit = 3, min = 0.5): { item: T; score: number }[] {
  const query = computeTokens(name.slice(0, 200));
  return candidates
    .map((item) => ({ item, score: similarity(query, tokens(item.name)) }))
    .filter((m) => m.score >= min)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

/** True when two names are the same apart from case, punctuation and plurals (parentheses count). */
export function sameExerciseName(a: string, b: string): boolean {
  const norm = (s: string) =>
    normalizeName(s)
      .split(' ')
      .map((w) => (SYNONYMS[w] ?? w))
      .join(' ')
      .split(' ')
      .map((w) => (w.length > 2 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
      .join(' ');
  return norm(a) === norm(b);
}
