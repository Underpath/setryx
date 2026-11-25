import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenWorkout, estimateWorkoutSeconds, secondsPerRep } from '../src/engine.ts';
import { cleanNotes, nameSimilarity, parseEquipment, parseRoutineExport, parseWeight } from '../src/routine-import.ts';
import type { WorkoutItem } from '../src/workouts.ts';

// Shaped like a real routines export: every block is a superset ending in a rest.
const routineExport = {
  version: 1,
  routines: [
    {
      id: 'r1',
      name: 'Push A',
      icon: '🫷',
      exercises: [
        {
          id: 'ss1', kind: 'superset', name: 'Chest press and side delts', rounds: 3,
          exercises: [
            { id: 'e1', name: 'Incline dumbbell press (~30 degrees)', desc: 'Weight: 8 kg per hand. Ribs down, flat back.', type: 'reps', reps: 10, tempo: '3-1-1-0', rir: '2', equipment: 'Dumbbells 8 kg, Incline bench' },
            { id: 'e2', name: 'Rest', desc: '', type: 'timed', duration: 20 },
            { id: 'e3', name: 'Seated dumbbell lateral raise', desc: 'Weight: 5 kg per hand. Lead with the elbows.', type: 'reps', reps: 8, equipment: 'Dumbbells 5 kg, Bench' },
            { id: 'e4', name: 'Rest', desc: '', type: 'timed', duration: 70 },
          ],
        },
        {
          id: 'ss2', kind: 'superset', name: 'Core', rounds: 2,
          exercises: [
            { id: 'e5', name: 'Side plank (Right)', desc: 'Hold 20-30 s.', type: 'timed', duration: 25, equipment: 'Bodyweight' },
            { id: 'e6', name: 'Transition', desc: '', type: 'timed', duration: 5 },
            { id: 'e7', name: 'Seated cable row (V-bar)', desc: 'Weight: 39 kg. Tall spine.', type: 'reps', reps: 10, equipment: 'Cable machine 45 kg, V-bar' },
            { id: 'e8', name: 'Rest', desc: '', type: 'timed', duration: 45 },
          ],
        },
      ],
    },
    {
      id: 'r2',
      name: 'Pull A',
      exercises: [{ id: 'e9', kind: 'exercise', name: 'Incline Dumbbell Press (~30 degrees)', type: 'reps', reps: 6 }],
    },
  ],
};

test('parses a routines export into workouts with rests, weights and supersets', () => {
  const result = parseRoutineExport(routineExport);
  assert.ok(result);
  assert.equal(result.workouts.length, 2);
  const push = result.workouts[0]!;
  assert.equal(push.name, 'Push A');
  assert.equal(push.icon, '🫷');
  const ss = push.items[0]!;
  assert.equal(ss.kind, 'superset');
  if (ss.kind !== 'superset') return;
  assert.equal(ss.rounds, 3);
  assert.deepEqual(ss.items.map((s) => s.kind), ['exercise', 'rest', 'exercise', 'rest']);
  const press = ss.items[0]!;
  assert.equal(press.kind, 'exercise');
  if (press.kind !== 'exercise') return;
  assert.equal(press.targetWeight, 8, 'per-hand weight is kept as one dumbbell');
  assert.equal(press.targetReps, 10);
  assert.equal(press.tempo, '3-1-1-0');
  assert.equal(press.rir, '2');
  assert.equal(press.notes, 'Ribs down, flat back.', 'weight sentence moves into the field');

  const core = push.items[1]!;
  if (core.kind !== 'superset') return assert.fail('expected superset');
  const transition = core.items[1]!;
  assert.equal(transition.kind, 'rest');
  if (transition.kind === 'rest') assert.equal(transition.label, 'Transition');
  const row = core.items[2]!;
  if (row.kind === 'exercise') assert.equal(row.targetWeight, 39, 'description weight wins over equipment text');
  const plank = core.items[0]!;
  if (plank.kind === 'exercise') {
    assert.equal(plank.targetType, 'timed');
    assert.equal(plank.targetDurationS, 25);
  }
});

test('identical exercise names share one exercise across workouts', () => {
  const result = parseRoutineExport(routineExport)!;
  const press = result.exercises.filter((e) => e.key.startsWith('incline dumbbell press'));
  assert.equal(press.length, 1);
  assert.deepEqual(press[0]!.equipment, ['Dumbbells', 'Incline bench']);
  assert.equal(result.exercises.some((e) => e.name === 'Rest' || e.name === 'Transition'), false);
});

test('accepts a bare array or a single routine, rejects junk', () => {
  assert.ok(parseRoutineExport(routineExport.routines));
  assert.ok(parseRoutineExport(routineExport.routines[1]));
  assert.equal(parseRoutineExport({ hello: 'world' }), null);
  assert.equal(parseRoutineExport([]), null);
  assert.equal(parseRoutineExport('nope'), null);
});

test('weight, equipment and notes helpers', () => {
  assert.deepEqual(parseWeight('Weight: 22,5 kg.', undefined), { weight: 22.5, source: 'Weight: 22,5 kg' });
  assert.equal(parseWeight('Bodyweight.', 'Pull-up bar'), null);
  assert.deepEqual(parseEquipment('Cable machine 22 kg, Rope'), ['Cable machine', 'Rope']);
  assert.deepEqual(parseEquipment('Bodyweight'), []);
  assert.equal(cleanNotes('Weight: 10 kg in one hand. Walk 20-30 m.'), 'Walk 20-30 m.');
  assert.equal(cleanNotes(''), null);
});

test('name similarity finds library equivalents', () => {
  assert.ok(nameSimilarity('Pull-ups', 'Pullups') >= 0.99);
  assert.ok(nameSimilarity('Incline dumbbell press (~30 degrees)', 'Incline Dumbbell Press') >= 0.99);
  assert.ok(nameSimilarity('Face pull (rope)', 'Face Pull') >= 0.99);
  assert.ok(nameSimilarity('Dead bug', 'Barbell Squat') < 0.3);
});

const items: WorkoutItem[] = [
  {
    kind: 'superset', id: 's', label: 'Block', rounds: 2,
    items: [
      { kind: 'exercise', id: 'a', exerciseId: 'x', targetType: 'reps', targetReps: 10, targetDurationS: null, targetWeight: 8, tempo: '3-1-1-0', rir: null, notes: null, equipmentNote: null },
      { kind: 'rest', id: 'r', durationS: 60, label: null },
    ],
  },
];

test('flatten expands rounds and drops the trailing rest', () => {
  const steps = flattenWorkout(items);
  assert.deepEqual(steps.map((s) => s.kind), ['exercise', 'rest', 'exercise']);
  assert.deepEqual(steps.map((s) => s.superset?.round), [1, 1, 2]);
  assert.equal(steps[2]!.superset?.position, 1);
});

test('duration estimate uses tempo', () => {
  assert.equal(secondsPerRep('3-1-1-0'), 5);
  assert.equal(secondsPerRep('2-X-1'), 4);
  assert.equal(secondsPerRep(null), 3);
  // 2 sets × (10 reps × 5 s + 5 s setup) + one 60 s rest
  assert.equal(estimateWorkoutSeconds(items), 2 * 55 + 60);
});
