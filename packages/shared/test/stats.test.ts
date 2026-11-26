import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestsOf, calendarWeeks, dailyStreak, e1rm, newRecords, recordTimeline, sessionMetrics, weeklyStats } from '../src/index.ts';

const now = new Date('2026-11-26T12:00:00'); // Thursday
const at = (iso: string, mins = 45) => ({ startedAt: new Date(iso).toISOString(), durationMs: mins * 60_000 });

test('Epley estimate', () => {
  assert.equal(e1rm(100, 1), 100);
  assert.equal(e1rm(100, 10), 133.3);
  assert.equal(e1rm(null, 10), null);
  assert.equal(e1rm(20, 0), null);
});

test('weekly streaks: current runs to last week until this week has a session', () => {
  const sessions = [
    at('2026-10-27T10:00:00'), // week of Oct 26
    at('2026-11-03T10:00:00'), // Nov 2
    at('2026-11-10T10:00:00'), // Nov 9
    at('2026-11-17T10:00:00'), // Nov 16
    at('2026-11-18T10:00:00', 30),
  ];
  const w = weeklyStats(sessions, now, 0, 6);
  assert.equal(w.current, 4, 'this week is empty, so the streak counts back from last week');
  assert.equal(w.best, 4);
  assert.deepEqual(w.weeks.map((x) => x.sessions), [0, 1, 1, 1, 2, 0]);
  assert.equal(w.weeks[4]!.durationMs, 75 * 60_000);
  assert.equal(w.thisWeek.sessions, 0);

  const withToday = weeklyStats([...sessions, at('2026-11-26T08:00:00')], now, 0, 6);
  assert.equal(withToday.current, 5);
  // A gap breaks it; the best stays.
  const gap = weeklyStats([at('2026-10-05T10:00:00'), at('2026-10-12T10:00:00'), at('2026-10-19T10:00:00'), at('2026-11-24T10:00:00')], now);
  assert.equal(gap.current, 1);
  assert.equal(gap.best, 3);
});

test('weekly streaks follow the week start', () => {
  // Sunday 22nd and Saturday 28th: the same week when weeks start on Sunday.
  const s = [at('2026-11-22T10:00:00'), at('2026-11-21T10:00:00')];
  assert.equal(weeklyStats(s, now, 6).thisWeek.sessions, 1);
  assert.equal(weeklyStats(s, now, 0).thisWeek.sessions, 0);
});

test('calendar grid ends with this week and marks the future', () => {
  const grid = calendarWeeks([at('2026-11-24T10:00:00'), at('2026-11-24T18:00:00')], now, 0, 4);
  assert.equal(grid.length, 4);
  const last = grid[3]!;
  assert.equal(last[0]!.key, '2026-11-23');
  assert.equal(last[1]!.sessions, 2);
  assert.equal(last[3]!.future, false);
  assert.equal(last[4]!.future, true);
});

test('records: heavier weight, more reps, longer holds; the first time is a baseline', () => {
  const prior = bestsOf([{ reps: 8, weight: 20, durationS: null }, { reps: 12, weight: null, durationS: null }]);
  assert.deepEqual(newRecords([{ reps: 6, weight: 22.5, durationS: null }], prior), [{ kind: 'weight', value: 22.5, previous: 20 }]);
  // Same weight, more reps: the estimate goes up.
  assert.deepEqual(newRecords([{ reps: 10, weight: 20, durationS: null }], prior).map((r) => r.kind), ['e1rm']);
  assert.deepEqual(newRecords([{ reps: 15, weight: null, durationS: null }], prior), [{ kind: 'reps', value: 15, previous: 12 }]);
  assert.deepEqual(newRecords([{ reps: 15, weight: null, durationS: null }], bestsOf([])), [], 'nothing to beat yet');
});

test('record timeline and per-session metrics', () => {
  const entries = [
    { sessionId: 'c', startedAt: '2026-11-20T10:00:00Z', workoutName: 'Push', sets: [{ reps: 8, weight: 25, durationS: null }] },
    { sessionId: 'a', startedAt: '2026-11-06T10:00:00Z', workoutName: 'Push', sets: [{ reps: 8, weight: 20, durationS: null }] },
    { sessionId: 'b', startedAt: '2026-11-13T10:00:00Z', workoutName: 'Push', sets: [{ reps: 8, weight: 20, durationS: null }, { reps: 10, weight: 20, durationS: null }] },
  ];
  const t = recordTimeline(entries);
  assert.deepEqual(t.map((r) => [r.sessionId, r.kind]), [['b', 'e1rm'], ['c', 'weight']]);
  const m = sessionMetrics(entries[2]!);
  assert.equal(m.topWeight, 20);
  assert.equal(m.totalReps, 18);
  assert.equal(m.volumeKg, 360);
  assert.equal(m.e1rm, 26.7);
});

test('daily streak: runs to yesterday until today has a session', () => {
  const s = [at('2026-11-20T10:00:00'), at('2026-11-21T10:00:00'), at('2026-11-23T09:00:00'), at('2026-11-24T09:00:00'), at('2026-11-25T21:00:00')];
  assert.deepEqual(dailyStreak(s, now), { current: 3, best: 3, today: false });
  assert.deepEqual(dailyStreak([...s, at('2026-11-26T07:00:00')], now), { current: 4, best: 4, today: true });
  assert.equal(dailyStreak([at('2026-11-20T10:00:00')], now).current, 0, 'a gap ends it');
});
