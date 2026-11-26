import { type Bests, type ExerciseHistoryEntry, type ExerciseStat, type SessionPoint, bestsOf, emptyBests } from '@setryx/shared';
import type { DB } from './db.ts';
import { getExercisesByIds } from './exercises.ts';

type LogRow = { session_id: string; started_at: string; workout_name: string; exercise_id: string; actual_reps: number | null; actual_weight: number | null; actual_duration_s: number | null };

/** Start times and durations, for the calendar and weekly totals. */
export function sessionPoints(db: DB, userId: string, since: string): SessionPoint[] {
  return (
    db.prepare('SELECT started_at, duration_ms FROM sessions WHERE user_id = ? AND started_at >= ? ORDER BY started_at').all(userId, since) as {
      started_at: string;
      duration_ms: number;
    }[]
  ).map((r) => ({ startedAt: r.started_at, durationMs: r.duration_ms }));
}

/** Names for exercises, from the library or, if one was deleted since, the latest session that used it. */
function namesFor(db: DB, userId: string, ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, e] of Object.entries(getExercisesByIds(db, userId, ids))) out[id] = e.name;
  const missing = ids.filter((id) => !out[id]);
  if (missing.length) {
    const snaps = db.prepare('SELECT snapshot FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 200').all(userId) as { snapshot: string }[];
    for (const { snapshot } of snaps) {
      const ex = (JSON.parse(snapshot) as { exercises?: Record<string, { name: string }> }).exercises ?? {};
      for (const id of missing) if (!out[id] && ex[id]) out[id] = ex[id].name;
      if (missing.every((id) => out[id])) break;
    }
  }
  return out;
}

function logs(db: DB, userId: string, where = '', params: (string | number)[] = []): LogRow[] {
  return db
    .prepare(
      `SELECT l.session_id, s.started_at, s.workout_name, l.exercise_id, l.actual_reps, l.actual_weight, l.actual_duration_s
       FROM set_logs l JOIN sessions s ON s.id = l.session_id
       WHERE s.user_id = ? ${where} ORDER BY s.started_at, l.step_index`,
    )
    .all(userId, ...params) as LogRow[];
}

const setOf = (r: LogRow) => ({ reps: r.actual_reps, weight: r.actual_weight, durationS: r.actual_duration_s });

/** Every exercise you've logged, with how often, when last and your bests. Most recent first. */
export function exerciseStats(db: DB, userId: string): ExerciseStat[] {
  const by = new Map<string, { sessions: Set<string>; last: string; sets: ReturnType<typeof setOf>[] }>();
  for (const r of logs(db, userId)) {
    const e = by.get(r.exercise_id) ?? { sessions: new Set<string>(), last: r.started_at, sets: [] };
    e.sessions.add(r.session_id);
    if (r.started_at > e.last) e.last = r.started_at;
    e.sets.push(setOf(r));
    by.set(r.exercise_id, e);
  }
  const names = namesFor(db, userId, [...by.keys()]);
  return [...by.entries()]
    .map(([exerciseId, e]) => ({ exerciseId, name: names[exerciseId] ?? 'Exercise', sessions: e.sessions.size, lastDoneAt: e.last, bests: bestsOf(e.sets) }))
    .sort((a, b) => b.lastDoneAt.localeCompare(a.lastDoneAt));
}

/** One exercise, session by session, oldest first. */
export function exerciseHistory(db: DB, userId: string, exerciseId: string): { name: string; entries: ExerciseHistoryEntry[] } | null {
  const rows = logs(db, userId, 'AND l.exercise_id = ?', [exerciseId]);
  if (!rows.length) return null;
  const entries = new Map<string, ExerciseHistoryEntry>();
  for (const r of rows) {
    const e = entries.get(r.session_id) ?? { sessionId: r.session_id, startedAt: r.started_at, workoutName: r.workout_name, sets: [] };
    e.sets.push(setOf(r));
    entries.set(r.session_id, e);
  }
  return { name: namesFor(db, userId, [exerciseId])[exerciseId] ?? 'Exercise', entries: [...entries.values()] };
}

/** Bests per exercise from every session except one (the one being reviewed). */
export function bestsFor(db: DB, userId: string, ids: string[], excludeSessionId?: string): Record<string, Bests> {
  const out: Record<string, Bests> = {};
  if (!ids.length) return out;
  const marks = ids.map(() => '?').join(',');
  const rows = logs(db, userId, `AND l.exercise_id IN (${marks}) ${excludeSessionId ? 'AND s.id != ?' : ''}`, [...ids, ...(excludeSessionId ? [excludeSessionId] : [])]);
  const sets = new Map<string, ReturnType<typeof setOf>[]>();
  for (const r of rows) sets.set(r.exercise_id, [...(sets.get(r.exercise_id) ?? []), setOf(r)]);
  for (const id of ids) out[id] = sets.has(id) ? bestsOf(sets.get(id)!) : emptyBests();
  return out;
}
