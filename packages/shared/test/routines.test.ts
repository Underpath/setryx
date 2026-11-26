import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Routine, type RoutineEntry, routineContextFor, routineInputSchema, routineStatus, startOfWeek, weekdayOf } from '../src/index.ts';

const entry = (id: string, weekday: number | null = null, workoutName: string | null = id): RoutineEntry => ({ id, workoutId: `w-${id}`, weekday, workoutName, icon: '' });
const rotation = [entry('pushA'), entry('pullA'), entry('pushB'), entry('pullB')];
const base = { startedAt: '2026-11-01T00:00:00.000Z', entries: rotation };
const run = (entryId: string, iso: string) => ({ entryId, startedAt: iso });
const now = new Date('2026-11-26T12:00:00'); // a Thursday

test('repeat: Push A → Pull A → Push B → Pull B, then back to Push A', () => {
  const r = { ...base, mode: 'repeat' as const };
  const next = (runs: ReturnType<typeof run>[]) => {
    const s = routineStatus(r, runs, now);
    return s.kind === 'next' ? s.entry.id : s.kind;
  };
  assert.equal(next([]), 'pushA');
  const runs = [run('pushA', '2026-11-20T10:00:00Z')];
  assert.equal(next(runs), 'pullA');
  runs.push(run('pullA', '2026-11-21T10:00:00Z'));
  assert.equal(next(runs), 'pushB');
  runs.push(run('pushB', '2026-11-23T10:00:00Z'));
  assert.equal(next(runs), 'pullB');
  runs.push(run('pullB', '2026-11-24T10:00:00Z'));
  assert.equal(next(runs), 'pushA', 'wraps around');
  // Order of the runs list doesn't matter, only the newest one.
  assert.equal(next([...runs].reverse()), 'pushA');
});

test('repeat: runs before a restart and entries of deleted workouts are ignored', () => {
  const r = { ...base, mode: 'repeat' as const, startedAt: '2026-11-22T00:00:00.000Z', entries: [entry('pushA'), entry('gone', null, null), entry('pullA')] };
  const s = routineStatus(r, [run('pushA', '2026-11-21T10:00:00Z')], now);
  assert.equal(s.kind === 'next' && s.entry.id, 'pushA', 'the run before the restart doesn’t count');
  const s2 = routineStatus(r, [run('pushA', '2026-11-23T10:00:00Z')], now);
  assert.equal(s2.kind === 'next' && s2.entry.id, 'pullA', 'the deleted workout is skipped');
  assert.equal(s2.kind === 'next' && s2.total, 2);
});

test('once: complete after the last workout', () => {
  const r = { ...base, mode: 'once' as const };
  const s = routineStatus(r, [run('pushA', '2026-11-20T10:00:00Z'), run('pullB', '2026-11-24T10:00:00Z')], now);
  assert.deepEqual(s, { kind: 'complete', finishedAt: '2026-11-24T10:00:00Z' });
});

test('weekly: today, missed earlier this week, and the next day when today is free', () => {
  assert.equal(weekdayOf(now), 3);
  assert.equal(startOfWeek(now).getDate(), 23, 'week starts Monday');
  const entries = [entry('mon', 0), entry('tue', 1), entry('thu', 3), entry('sat', 5)];
  const r = { ...base, mode: 'weekly' as const, entries };
  const monday = new Date(startOfWeek(now).getTime() + 9 * 3600_000).toISOString();
  const lastWeek = new Date(startOfWeek(now).getTime() - 24 * 3600_000).toISOString();
  const s = routineStatus(r, [run('mon', monday), run('tue', lastWeek)], now);
  assert.equal(s.kind, 'week');
  if (s.kind !== 'week') return;
  assert.deepEqual(s.today.map((t) => [t.entry.id, t.doneAt]), [['thu', null]]);
  assert.deepEqual(s.missed.map((e) => e.id), ['tue'], 'done last week doesn’t count for this week');
  assert.equal(s.upcoming, null);

  const friday = new Date('2026-11-27T12:00:00');
  const s2 = routineStatus(r, [], friday);
  assert.ok(s2.kind === 'week' && s2.today.length === 0 && s2.upcoming?.weekday === 5);
  const sunday = new Date('2026-11-29T12:00:00');
  const s3 = routineStatus(r, [], sunday);
  assert.ok(s3.kind === 'week' && s3.upcoming?.weekday === 0, 'wraps to next Monday');
});

test('weekly with the week starting on Sunday', () => {
  const entries = [entry('sun', 6), entry('mon', 0), entry('thu', 3)];
  const r = { ...base, mode: 'weekly' as const, entries };
  assert.equal(startOfWeek(now, 6).getDate(), 22, 'Sunday the 22nd');
  const s = routineStatus(r, [], now, 6);
  assert.ok(s.kind === 'week');
  if (s.kind !== 'week') return;
  assert.deepEqual(s.missed.map((e) => e.id), ['sun', 'mon'], 'Sunday comes first and is already missed');
  // Done on Sunday the 22nd: counts for this week only when the week starts on Sunday.
  const sundayRun = [run('sun', new Date('2026-11-22T10:00:00').toISOString())];
  const s6 = routineStatus(r, sundayRun, now, 6);
  assert.ok(s6.kind === 'week' && !s6.missed.some((e) => e.id === 'sun'));
  const s0 = routineStatus(r, sundayRun, now, 0);
  assert.ok(s0.kind === 'week' && !s0.missed.some((e) => e.id === 'sun'), 'with a Monday start, Sunday is later this week, not missed');
});

test('a workout started on its own counts for the routine waiting on it', () => {
  const r: Routine = { ...base, id: 'r1', name: 'PPL', mode: 'repeat', active: true, runs: [run('pushA', '2026-11-20T10:00:00Z')], createdAt: '', updatedAt: '' };
  assert.deepEqual(routineContextFor('w-pullA', [r], now), { routineId: 'r1', entryId: 'pullA' });
  assert.equal(routineContextFor('w-pushB', [r], now), null, 'not due yet');
  assert.equal(routineContextFor('w-pullA', [{ ...r, active: false }], now), null, 'paused routines don’t count');
  // A session still waiting to upload moves the routine on.
  assert.deepEqual(routineContextFor('w-pushB', [r], now, [{ routineId: 'r1', entryId: 'pullA', startedAt: '2026-11-25T10:00:00Z' }]), { routineId: 'r1', entryId: 'pushB' });
});

test('routine input: weekly needs a day on every workout', () => {
  const ok = routineInputSchema.safeParse({ name: 'Week', mode: 'weekly', entries: [{ id: 'a', workoutId: 'w', weekday: 2 }] });
  assert.ok(ok.success);
  const bad = routineInputSchema.safeParse({ name: 'Week', mode: 'weekly', entries: [{ id: 'a', workoutId: 'w' }] });
  assert.ok(!bad.success);
});
