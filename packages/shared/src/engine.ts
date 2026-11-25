import type { BlockStep, ExerciseStep, RestStep, WorkoutItem } from './workouts.ts';

/** One step of a running workout, after supersets are expanded into rounds. */
export type FlatStep = (
  | ({ kind: 'exercise' } & Omit<ExerciseStep, 'kind'>)
  | ({ kind: 'rest' } & Omit<RestStep, 'kind'>)
) & {
  /** Index of the top-level item this step came from. */
  blockIndex: number;
  /** Superset context, when the step is inside one. */
  superset: { id: string; label: string; round: number; rounds: number; position: number; size: number } | null;
};

/**
 * Expands a workout into the linear list of steps the player walks through.
 * A trailing rest is dropped: there's nothing to rest for after the last set.
 */
export function flattenWorkout(items: WorkoutItem[]): FlatStep[] {
  const steps: FlatStep[] = [];
  items.forEach((item, blockIndex) => {
    if (item.kind === 'superset') {
      for (let round = 1; round <= item.rounds; round++) {
        item.items.forEach((step: BlockStep, i) => {
          steps.push({
            ...step,
            blockIndex,
            superset: { id: item.id, label: item.label || 'Superset', round, rounds: item.rounds, position: i + 1, size: item.items.length },
          } as FlatStep);
        });
      }
    } else {
      steps.push({ ...item, blockIndex, superset: null } as FlatStep);
    }
  });
  while (steps.length && steps[steps.length - 1]!.kind === 'rest') steps.pop();
  return steps;
}

/** Seconds per rep from a tempo like "3-1-1-0"; falls back to 3 s when missing or unreadable. */
export function secondsPerRep(tempo: string | null | undefined): number {
  if (!tempo) return 3;
  const parts = tempo.split(/[-/ ]+/).map((p) => (p.toUpperCase() === 'X' ? 1 : Number(p)));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 3;
  const sum = parts.reduce((a, b) => a + b, 0);
  return sum > 0 ? sum : 3;
}

const SET_SETUP_S = 5;

export function estimateStepSeconds(step: FlatStep): number {
  if (step.kind === 'rest') return step.durationS;
  if (step.targetType === 'timed') return (step.targetDurationS ?? 0) + SET_SETUP_S;
  return (step.targetReps ?? 0) * secondsPerRep(step.tempo) + SET_SETUP_S;
}

export function estimateWorkoutSeconds(items: WorkoutItem[]): number {
  return flattenWorkout(items).reduce((total, s) => total + estimateStepSeconds(s), 0);
}

export function summarizeItems(items: WorkoutItem[]) {
  return {
    blockCount: items.length,
    supersetCount: items.filter((i) => i.kind === 'superset').length,
    stepCount: flattenWorkout(items).length,
    estimatedS: estimateWorkoutSeconds(items),
  };
}

/** Every exercise id a workout refers to. */
export function exerciseIdsOf(items: WorkoutItem[]): string[] {
  const ids = new Set<string>();
  for (const it of items) {
    if (it.kind === 'exercise') ids.add(it.exerciseId);
    if (it.kind === 'superset') for (const s of it.items) if (s.kind === 'exercise') ids.add(s.exerciseId);
  }
  return [...ids];
}
