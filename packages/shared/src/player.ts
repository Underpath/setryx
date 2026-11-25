// The workout player as plain data + pure functions, so it can be saved after
// every change, restored after a reload, and tested without a browser.
import { type FlatStep, flattenWorkout } from './engine.ts';
import type { WorkoutItem } from './workouts.ts';

export type SnapshotExercise = { name: string; equipment: string[]; instructions: string[] };

export type SetLog = {
  stepIndex: number;
  itemId: string;
  exerciseId: string;
  round: number | null;
  plannedReps: number | null;
  actualReps: number | null;
  plannedWeight: number | null;
  actualWeight: number | null;
  plannedDurationS: number | null;
  actualDurationS: number | null;
  completedAt: number;
};

export type PlayerState = {
  version: 1;
  id: string;
  userId: string;
  workoutId: string;
  workoutName: string;
  icon: string;
  items: WorkoutItem[];
  exercises: Record<string, SnapshotExercise>;
  phase: 'ready' | 'running' | 'finished';
  index: number;
  /** ms timestamps */
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** When the current step began (for timing timed exercises the user ends early). */
  stepStartedAt: number | null;
  /** Timed steps: when the timer runs out. Null while paused or on a reps step. */
  endsAt: number | null;
  /** Timed steps while paused: what was left. */
  remainingMs: number | null;
  paused: boolean;
  pausedAt: number | null;
  pausedTotalMs: number;
  warned: boolean;
  logs: Record<number, SetLog>;
};

export type PlayerEvent =
  | { type: 'warn'; next: FlatStep | null }
  | { type: 'timerEnd' }
  | { type: 'finished' };

const cache = new WeakMap<WorkoutItem[], FlatStep[]>();
/** The flattened step list (memoised per snapshot). */
export function stepsOf(s: Pick<PlayerState, 'items'>): FlatStep[] {
  let steps = cache.get(s.items);
  if (!steps) {
    steps = flattenWorkout(s.items);
    cache.set(s.items, steps);
  }
  return steps;
}

export function currentStep(s: PlayerState): FlatStep | null {
  return stepsOf(s)[s.index] ?? null;
}

export function isTimed(step: FlatStep | null): boolean {
  return !!step && (step.kind === 'rest' || step.targetType === 'timed');
}

export function stepDurationMs(step: FlatStep): number {
  if (step.kind === 'rest') return step.durationS * 1000;
  return (step.targetDurationS ?? 0) * 1000;
}

export function createPlayer(init: {
  id: string;
  userId: string;
  workoutId: string;
  workoutName: string;
  icon: string;
  items: WorkoutItem[];
  exercises: Record<string, SnapshotExercise>;
  now: number;
}): PlayerState {
  return {
    version: 1,
    ...init,
    phase: 'ready',
    index: 0,
    createdAt: init.now,
    startedAt: null,
    finishedAt: null,
    stepStartedAt: null,
    endsAt: null,
    remainingMs: null,
    paused: false,
    pausedAt: null,
    pausedTotalMs: 0,
    warned: false,
    logs: {},
  };
}

function enter(s: PlayerState, index: number, now: number): PlayerState {
  const step = stepsOf(s)[index] ?? null;
  return {
    ...s,
    index,
    stepStartedAt: now,
    endsAt: isTimed(step) ? now + stepDurationMs(step!) : null,
    remainingMs: null,
    paused: false,
    pausedAt: null,
    pausedTotalMs: s.paused && s.pausedAt ? s.pausedTotalMs + (now - s.pausedAt) : s.pausedTotalMs,
    warned: false,
  };
}

export function start(s: PlayerState, now: number): PlayerState {
  if (s.phase !== 'ready') return s;
  return enter({ ...s, phase: 'running', startedAt: now }, 0, now);
}

/** Records the current step as done (as planned, unless already corrected). */
function logCurrent(s: PlayerState, now: number): PlayerState {
  const step = currentStep(s);
  if (!step || step.kind !== 'exercise') return s;
  const prev = s.logs[s.index];
  // A timed exercise ended early counts the seconds actually done.
  const left = remainingMs(s, now) ?? 0;
  const doneS = Math.round((stepDurationMs(step) - left) / 1000);
  const log: SetLog = {
    stepIndex: s.index,
    itemId: step.id,
    exerciseId: step.exerciseId,
    round: step.superset?.round ?? null,
    plannedReps: step.targetReps,
    actualReps: prev?.actualReps ?? step.targetReps,
    plannedWeight: step.targetWeight,
    actualWeight: prev?.actualWeight ?? step.targetWeight,
    plannedDurationS: step.targetDurationS,
    actualDurationS:
      step.targetType === 'timed'
        ? (prev?.actualDurationS ?? Math.min(step.targetDurationS ?? 0, Math.max(0, doneS)))
        : null,
    completedAt: now,
  };
  return { ...s, logs: { ...s.logs, [s.index]: log } };
}

/** Log the current set (or skip the rest) and move on. Finishes after the last step. */
export function next(s: PlayerState, now: number): { state: PlayerState; events: PlayerEvent[] } {
  if (s.phase !== 'running') return { state: s, events: [] };
  const logged = logCurrent(s, now);
  if (s.index >= stepsOf(s).length - 1) {
    return {
      state: { ...logged, phase: 'finished', finishedAt: now, endsAt: null, remainingMs: null, paused: false, pausedAt: null },
      events: [{ type: 'finished' }],
    };
  }
  return { state: enter(logged, s.index + 1, now), events: [] };
}

export function back(s: PlayerState, now: number): PlayerState {
  if (s.phase !== 'running' || s.index === 0) return s;
  return enter(s, s.index - 1, now);
}

export function pause(s: PlayerState, now: number): PlayerState {
  if (s.phase !== 'running' || s.paused) return s;
  return { ...s, paused: true, pausedAt: now, remainingMs: s.endsAt !== null ? Math.max(0, s.endsAt - now) : null, endsAt: null };
}

/** Called once the 3-2-1 countdown has finished. */
export function resume(s: PlayerState, now: number): PlayerState {
  if (s.phase !== 'running' || !s.paused) return s;
  return {
    ...s,
    paused: false,
    pausedAt: null,
    pausedTotalMs: s.pausedTotalMs + (s.pausedAt ? now - s.pausedAt : 0),
    endsAt: s.remainingMs !== null ? now + s.remainingMs : null,
    remainingMs: null,
  };
}

export function remainingMs(s: PlayerState, now: number): number | null {
  if (s.paused) return s.remainingMs;
  return s.endsAt === null ? null : Math.max(0, s.endsAt - now);
}

/**
 * Advances time. Emits the warning once when the timer gets inside the
 * warning window, and moves on when it runs out. Only one step is advanced
 * per call, so a long time in the background never skips past a reps set.
 */
export function tick(s: PlayerState, now: number, warnSeconds: number): { state: PlayerState; events: PlayerEvent[] } {
  if (s.phase !== 'running' || s.paused || s.endsAt === null) return { state: s, events: [] };
  const left = s.endsAt - now;
  const events: PlayerEvent[] = [];
  let state = s;
  const dur = stepDurationMs(currentStep(s)!);
  if (!s.warned && warnSeconds > 0 && left <= warnSeconds * 1000 && left > 0 && dur > warnSeconds * 1000) {
    state = { ...state, warned: true };
    events.push({ type: 'warn', next: stepsOf(s)[s.index + 1] ?? null });
  }
  if (left <= 0) {
    events.push({ type: 'timerEnd' });
    const r = next(state, now);
    return { state: r.state, events: [...events, ...r.events] };
  }
  return { state, events };
}

/** Corrects the log of an already-done set (during the following rest, or at the end). */
export function adjustLog(s: PlayerState, stepIndex: number, patch: Partial<Pick<SetLog, 'actualReps' | 'actualWeight' | 'actualDurationS'>>): PlayerState {
  const log = s.logs[stepIndex];
  if (!log) return s;
  const clean = <T extends number | null | undefined>(v: T, max: number) => (v == null ? v : Math.min(max, Math.max(0, Math.round(v * 10) / 10)));
  return {
    ...s,
    logs: {
      ...s.logs,
      [stepIndex]: {
        ...log,
        ...(patch.actualReps !== undefined ? { actualReps: clean(patch.actualReps, 999) } : {}),
        ...(patch.actualWeight !== undefined ? { actualWeight: clean(patch.actualWeight, 2000) } : {}),
        ...(patch.actualDurationS !== undefined ? { actualDurationS: clean(patch.actualDurationS, 36_000) } : {}),
      },
    },
  };
}

/** The set to show for correction while resting: the exercise step just before this rest. */
export function correctableLog(s: PlayerState): SetLog | null {
  const step = currentStep(s);
  if (!step || step.kind !== 'rest') return null;
  for (let i = s.index - 1; i >= 0; i--) {
    const prev = stepsOf(s)[i]!;
    if (prev.kind === 'exercise') return s.logs[i] ?? null;
  }
  return null;
}

/** Workout time so far, without pauses. */
export function elapsedMs(s: PlayerState, now: number): number {
  if (!s.startedAt) return 0;
  const end = s.finishedAt ?? now;
  const pausedNow = s.paused && s.pausedAt ? end - s.pausedAt : 0;
  return Math.max(0, end - s.startedAt - s.pausedTotalMs - pausedNow);
}

/** Equipment to lay out before starting, grouped by block. */
export function equipmentChecklist(s: Pick<PlayerState, 'items' | 'exercises'>): { label: string; items: string[] }[] {
  const groups: { label: string; items: string[] }[] = [];
  const main: string[] = [];
  const add = (list: string[], seen: Set<string>, values: string[]) => {
    for (const v of values) {
      const key = v.trim().toLowerCase();
      if (key && key !== 'bodyweight' && key !== 'body only' && !seen.has(key)) {
        seen.add(key);
        list.push(v.trim());
      }
    }
  };
  const fromStep = (step: { exerciseId: string; equipmentNote: string | null }) =>
    step.equipmentNote ? step.equipmentNote.split(',') : (s.exercises[step.exerciseId]?.equipment ?? []);
  const mainSeen = new Set<string>();
  for (const it of s.items) {
    if (it.kind === 'exercise') add(main, mainSeen, fromStep(it));
    if (it.kind === 'superset') {
      const list: string[] = [];
      const seen = new Set<string>();
      for (const c of it.items) if (c.kind === 'exercise') add(list, seen, fromStep(c));
      if (list.length) groups.push({ label: it.label || 'Superset', items: list });
    }
  }
  return main.length ? [{ label: 'Main', items: main }, ...groups] : groups;
}

/** When on the last step of a superset's last round: the next block's name and equipment. */
export function nextBlockPreview(s: PlayerState): { label: string; items: string[] } | null {
  const step = currentStep(s);
  if (!step?.superset) return null;
  const last = step.superset.round === step.superset.rounds && step.superset.position === step.superset.size;
  if (!last) return null;
  const nextBlock = s.items.slice(step.blockIndex + 1).find((it) => it.kind === 'superset');
  if (!nextBlock || nextBlock.kind !== 'superset') return null;
  const [group] = equipmentChecklist({ items: [nextBlock], exercises: s.exercises });
  return { label: nextBlock.label || 'Superset', items: group?.items ?? [] };
}

export function loggedSets(s: PlayerState): SetLog[] {
  return Object.values(s.logs).sort((a, b) => a.stepIndex - b.stepIndex);
}
