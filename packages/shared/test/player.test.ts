import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustLog,
  back,
  correctableLog,
  createPlayer,
  currentStep,
  elapsedMs,
  equipmentChecklist,
  next,
  nextBlockPreview,
  pause,
  remainingMs,
  resume,
  start,
  tick,
} from '../src/player.ts';
import type { WorkoutItem } from '../src/workouts.ts';

const ex = (id: string, exerciseId: string, extra: Partial<Extract<WorkoutItem, { kind: 'exercise' }>> = {}) =>
  ({
    kind: 'exercise', id, exerciseId, targetType: 'reps', targetReps: 10, targetDurationS: null, targetWeight: 8,
    tempo: null, rir: null, notes: null, equipmentNote: null, ...extra,
  }) as const;

const items: WorkoutItem[] = [
  {
    kind: 'superset', id: 's1', label: 'Chest', rounds: 2,
    items: [ex('press', 'e-press', { equipmentNote: 'Dumbbells 8 kg, Incline bench' }), { kind: 'rest', id: 'r1', durationS: 30, label: null }],
  },
  {
    kind: 'superset', id: 's2', label: 'Core', rounds: 1,
    items: [ex('plank', 'e-plank', { targetType: 'timed', targetReps: null, targetDurationS: 20, targetWeight: null }), { kind: 'rest', id: 'r2', durationS: 15, label: null }],
  },
];
const exercises = { 'e-press': { name: 'Press', equipment: ['dumbbell'], instructions: [] }, 'e-plank': { name: 'Plank', equipment: ['body only'], instructions: [] } };

const T0 = 1_000_000;
const fresh = () => start(createPlayer({ id: 's', userId: 'u', workoutId: 'w', workoutName: 'Push', icon: '', items, exercises, now: T0 - 5000 }), T0);

test('steps: press, rest, press, rest, plank (trailing rest dropped)', () => {
  let s = fresh();
  const seen: string[] = [];
  for (let i = 0; i < 10 && s.phase === 'running'; i++) {
    seen.push(currentStep(s)!.id);
    s = next(s, T0 + i * 1000).state;
  }
  assert.deepEqual(seen, ['press', 'r1', 'press', 'r1', 'plank']);
  assert.equal(s.phase, 'finished');
});

test('a reps set is logged as planned when you move on', () => {
  const s = next(fresh(), T0 + 40_000).state;
  assert.deepEqual([s.logs[0]!.actualReps, s.logs[0]!.actualWeight, s.logs[0]!.round], [10, 8, 1]);
  assert.equal(currentStep(s)!.kind, 'rest');
  assert.equal(remainingMs(s, T0 + 40_000), 30_000);
});

test('the set can be corrected during the rest, and the correction sticks', () => {
  let s = next(fresh(), T0).state; // now resting
  assert.equal(correctableLog(s)?.stepIndex, 0);
  s = adjustLog(s, 0, { actualReps: 9, actualWeight: 7.5 });
  assert.deepEqual([s.logs[0]!.actualReps, s.logs[0]!.actualWeight], [9, 7.5]);
  s = back(s, T0 + 1000); // back to the press and log it again
  s = next(s, T0 + 2000).state;
  assert.equal(s.logs[0]!.actualReps, 9, 'going back and forward keeps the correction');
});

test('rest timer: warning once, then moves on by itself', () => {
  let s = next(fresh(), T0).state; // rest of 30 s
  let r = tick(s, T0 + 10_000, 10);
  assert.equal(r.events.length, 0);
  r = tick(r.state, T0 + 20_500, 10);
  assert.equal(r.events[0]?.type, 'warn');
  if (r.events[0]?.type === 'warn') assert.equal(r.events[0].next?.id, 'press');
  r = tick(r.state, T0 + 21_000, 10);
  assert.equal(r.events.length, 0, 'warns only once');
  r = tick(r.state, T0 + 30_000, 10);
  assert.deepEqual(r.events.map((e) => e.type), ['timerEnd']);
  s = r.state;
  assert.equal(currentStep(s)!.id, 'press');
  assert.equal(currentStep(s)!.superset?.round, 2);
});

test('timer is based on timestamps: a frozen tab catches up', () => {
  const s = next(fresh(), T0).state;
  // No ticks for 45 s (screen off). One tick moves exactly one step.
  const r = tick(s, T0 + 45_000, 10);
  assert.equal(currentStep(r.state)!.id, 'press');
  assert.equal(r.state.endsAt, null, 'reps step has no timer');
});

test('pause keeps the remaining time; resume continues from there', () => {
  let s = next(fresh(), T0).state; // 30 s rest
  s = pause(s, T0 + 12_000);
  assert.equal(remainingMs(s, T0 + 50_000), 18_000, 'time stands still while paused');
  assert.equal(tick(s, T0 + 60_000, 10).events.length, 0);
  s = resume(s, T0 + 60_000);
  assert.equal(remainingMs(s, T0 + 61_000), 17_000);
  assert.equal(elapsedMs(s, T0 + 61_000), 61_000 - 48_000, 'paused time is not workout time');
});

test('a timed exercise ended early logs the seconds actually done', () => {
  let s = fresh();
  for (let i = 0; i < 4; i++) s = next(s, T0).state; // to the plank
  assert.equal(currentStep(s)!.id, 'plank');
  const r = next(s, T0 + 12_000);
  assert.equal(r.state.logs[4]!.actualDurationS, 12);
  assert.deepEqual(r.events.map((e) => e.type), ['finished']);
});

test('equipment checklist groups by block and skips bodyweight', () => {
  const groups = equipmentChecklist({ items, exercises });
  assert.deepEqual(groups, [{ label: 'Chest', items: ['Dumbbells 8 kg', 'Incline bench'] }]);
});

test('next-block preview shows on the last step of the last round', () => {
  let s = fresh();
  assert.equal(nextBlockPreview(s), null);
  for (let i = 0; i < 3; i++) s = next(s, T0).state; // press round 2... rest round 2
  assert.equal(currentStep(s)!.id, 'r1');
  assert.equal(nextBlockPreview(s)?.label, 'Core');
});
