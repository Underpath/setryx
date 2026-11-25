import { randomUUID } from 'node:crypto';
import type { Routine, RoutineEntry, RoutineMode } from '@setryx/shared';
import { type DB, now, tx } from './db.ts';
import { HttpError } from './http.ts';

type RoutineRow = { id: string; user_id: string; name: string; mode: RoutineMode; active: number; started_at: string; created_at: string; updated_at: string };
type EntryRow = { id: string; workout_id: string; position: number; weekday: number | null; name: string | null; icon: string | null };

export type RoutineFields = { name: string; mode: RoutineMode; active: boolean; entries: { id: string; workoutId: string; weekday: number | null }[] };

/** How many recent runs come with each routine: enough for any status. */
const RUNS_LIMIT = 60;

function toRoutine(db: DB, r: RoutineRow): Routine {
  const entries = (
    db
      .prepare(
        `SELECT e.id, e.workout_id, e.position, e.weekday, w.name, w.icon
         FROM routine_entries e LEFT JOIN workouts w ON w.id = e.workout_id AND w.archived = 0 AND w.user_id = ?
         WHERE e.routine_id = ? ORDER BY e.position`,
      )
      .all(r.user_id, r.id) as EntryRow[]
  ).map((e): RoutineEntry => ({ id: e.id, workoutId: e.workout_id, weekday: e.weekday, workoutName: e.name, icon: e.icon ?? '' }));
  const runs = (
    db
      .prepare(
        `SELECT routine_entry_id AS entryId, started_at AS startedAt FROM sessions
         WHERE user_id = ? AND routine_id = ? AND started_at >= ? AND routine_entry_id IS NOT NULL
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(r.user_id, r.id, r.started_at, RUNS_LIMIT) as { entryId: string; startedAt: string }[]
  ).map((x) => ({ entryId: x.entryId, startedAt: x.startedAt }));
  return { id: r.id, name: r.name, mode: r.mode, active: !!r.active, startedAt: r.started_at, entries, runs, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listRoutines(db: DB, userId: string): Routine[] {
  const rows = db.prepare('SELECT * FROM routines WHERE user_id = ? ORDER BY created_at').all(userId) as RoutineRow[];
  return rows.map((r) => toRoutine(db, r));
}

export function getRoutine(db: DB, userId: string, id: string): Routine | null {
  const r = db.prepare('SELECT * FROM routines WHERE id = ? AND user_id = ?').get(id, userId) as RoutineRow | undefined;
  return r ? toRoutine(db, r) : null;
}

/** Every workout in a routine must be one of the user's own, not deleted. */
function assertWorkoutsUsable(db: DB, userId: string, f: RoutineFields, keep: Set<string>) {
  const check = db.prepare('SELECT 1 FROM workouts WHERE id = ? AND user_id = ? AND archived = 0');
  for (const e of f.entries) {
    // An entry whose workout was deleted since may stay as it was.
    if (keep.has(`${e.id}:${e.workoutId}`)) continue;
    if (!check.get(e.workoutId, userId)) throw new HttpError(400, 'invalid_input', 'One of the workouts doesn’t exist or was deleted.');
  }
}

function saveEntries(db: DB, routineId: string, f: RoutineFields) {
  db.prepare('DELETE FROM routine_entries WHERE routine_id = ?').run(routineId);
  const ins = db.prepare('INSERT INTO routine_entries (routine_id, id, workout_id, position, weekday) VALUES (?, ?, ?, ?, ?)');
  f.entries.forEach((e, i) => ins.run(routineId, e.id, e.workoutId, i, f.mode === 'weekly' ? e.weekday : null));
}

export function createRoutine(db: DB, userId: string, f: RoutineFields): Routine {
  assertWorkoutsUsable(db, userId, f, new Set());
  const id = randomUUID();
  const ts = now();
  tx(db, () => {
    db.prepare('INSERT INTO routines (id, user_id, name, mode, active, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, userId, f.name, f.mode, f.active ? 1 : 0, ts, ts, ts,
    );
    saveEntries(db, id, f);
  });
  return getRoutine(db, userId, id)!;
}

export function replaceRoutine(db: DB, userId: string, id: string, f: RoutineFields): Routine | null {
  const existing = getRoutine(db, userId, id);
  if (!existing) return null;
  assertWorkoutsUsable(db, userId, f, new Set(existing.entries.map((e) => `${e.id}:${e.workoutId}`)));
  tx(db, () => {
    db.prepare('UPDATE routines SET name = ?, mode = ?, active = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(f.name, f.mode, f.active ? 1 : 0, now(), id, userId);
    saveEntries(db, id, f);
  });
  return getRoutine(db, userId, id);
}

export function setRoutineActive(db: DB, userId: string, id: string, active: boolean): Routine | null {
  const res = db.prepare('UPDATE routines SET active = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(active ? 1 : 0, now(), id, userId);
  return res.changes ? getRoutine(db, userId, id) : null;
}

/** Start counting progress again from now. */
export function restartRoutine(db: DB, userId: string, id: string): Routine | null {
  const ts = now();
  const res = db.prepare('UPDATE routines SET started_at = ?, active = 1, updated_at = ? WHERE id = ? AND user_id = ?').run(ts, ts, id, userId);
  return res.changes ? getRoutine(db, userId, id) : null;
}

/** Deletes the routine. Its sessions stay in the history. */
export function deleteRoutine(db: DB, userId: string, id: string): boolean {
  return db.prepare('DELETE FROM routines WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}
