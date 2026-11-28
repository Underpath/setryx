import { randomUUID } from 'node:crypto';
import {
  type BlockStep,
  type Workout,
  type WorkoutItem,
  type WorkoutSummary,
  exerciseIdsOf,
  summarizeItems,
} from '@setryx/shared';
import { type DB, now, tx } from './db.ts';
import { getExercisesByIds } from './exercises.ts';
import { absorbStepCues } from './cues.ts';
import { HttpError } from './http.ts';

type WorkoutRow = { id: string; user_id: string; name: string; icon: string; notes: string | null; created_at: string; updated_at: string };
type ItemRow = { id: string; parent_id: string | null; position: number; kind: WorkoutItem['kind']; data: string };

export type WorkoutFields = { name: string; icon: string; notes: string | null; items: WorkoutItem[] };

function loadItems(db: DB, workoutId: string): WorkoutItem[] {
  const rows = db.prepare('SELECT id, parent_id, position, kind, data FROM workout_items WHERE workout_id = ? ORDER BY position').all(workoutId) as ItemRow[];
  const top: WorkoutItem[] = [];
  const supersets = new Map<string, Extract<WorkoutItem, { kind: 'superset' }>>();
  for (const r of rows.filter((r) => r.parent_id === null)) {
    const item = { ...JSON.parse(r.data), id: r.id, kind: r.kind } as WorkoutItem;
    if (item.kind === 'superset') {
      item.items = [];
      supersets.set(item.id, item);
    }
    top.push(item);
  }
  for (const r of rows.filter((r) => r.parent_id !== null)) {
    supersets.get(r.parent_id!)?.items.push({ ...JSON.parse(r.data), id: r.id, kind: r.kind } as BlockStep);
  }
  return top;
}

function saveItems(db: DB, workoutId: string, items: WorkoutItem[]): void {
  db.prepare('DELETE FROM workout_items WHERE workout_id = ?').run(workoutId);
  const ins = db.prepare('INSERT INTO workout_items (workout_id, id, parent_id, position, kind, exercise_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const strip = <T extends { id: string; kind: string }>(o: T) => {
    const { id: _id, kind: _kind, ...rest } = o;
    return rest;
  };
  items.forEach((item, i) => {
    if (item.kind === 'superset') {
      const { items: children, ...ss } = item;
      ins.run(workoutId, item.id, null, i, 'superset', null, JSON.stringify(strip(ss)));
      children.forEach((c, j) => ins.run(workoutId, c.id, item.id, j, c.kind, c.kind === 'exercise' ? c.exerciseId : null, JSON.stringify(strip(c))));
    } else {
      ins.run(workoutId, item.id, null, i, item.kind, item.kind === 'exercise' ? item.exerciseId : null, JSON.stringify(strip(item)));
    }
  });
}

function toWorkout(db: DB, r: WorkoutRow): Workout {
  return { id: r.id, name: r.name, icon: r.icon, notes: r.notes, items: loadItems(db, r.id), createdAt: r.created_at, updatedAt: r.updated_at };
}

/** Every exercise a workout refers to must be in the library or be the user's own. */
function assertExercisesUsable(db: DB, userId: string, items: WorkoutItem[]): void {
  const ids = exerciseIdsOf(items);
  const found = getExercisesByIds(db, userId, ids);
  const missing = ids.filter((id) => !found[id]);
  if (missing.length) throw new HttpError(400, 'unknown_exercise', 'One of the exercises in this workout no longer exists. Pick another one.');
}

export function listWorkouts(db: DB, userId: string): WorkoutSummary[] {
  const rows = db.prepare('SELECT * FROM workouts WHERE user_id = ? AND archived = 0 ORDER BY created_at').all(userId) as WorkoutRow[];
  return rows.map((r) => ({ id: r.id, name: r.name, icon: r.icon, updatedAt: r.updated_at, ...summarizeItems(loadItems(db, r.id)) }));
}

export function getWorkout(db: DB, userId: string, id: string): Workout | null {
  const r = db.prepare('SELECT * FROM workouts WHERE id = ? AND user_id = ? AND archived = 0').get(id, userId) as WorkoutRow | undefined;
  return r ? toWorkout(db, r) : null;
}

export function createWorkout(db: DB, userId: string, f: WorkoutFields): Workout {
  assertExercisesUsable(db, userId, f.items);
  f = { ...f, items: absorbStepCues(db, userId, f.items) };
  const id = randomUUID();
  const ts = now();
  tx(db, () => {
    db.prepare('INSERT INTO workouts (id, user_id, name, icon, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, userId, f.name, f.icon, f.notes, ts, ts);
    saveItems(db, id, f.items);
  });
  return getWorkout(db, userId, id)!;
}

export function replaceWorkout(db: DB, userId: string, id: string, f: WorkoutFields): Workout | null {
  if (!getWorkout(db, userId, id)) return null;
  assertExercisesUsable(db, userId, f.items);
  f = { ...f, items: absorbStepCues(db, userId, f.items) };
  tx(db, () => {
    db.prepare('UPDATE workouts SET name = ?, icon = ?, notes = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(f.name, f.icon, f.notes, now(), id, userId);
    saveItems(db, id, f.items);
  });
  return getWorkout(db, userId, id);
}

/**
 * Soft delete, so past sessions keep their link. Nothing reads a deleted
 * workout's steps or notes (sessions keep their own copy), so those go and
 * the space counts as freed.
 */
export function archiveWorkout(db: DB, userId: string, id: string): boolean {
  return tx(db, () => {
    const done = db.prepare('UPDATE workouts SET archived = 1, notes = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND archived = 0').run(now(), id, userId).changes > 0;
    if (done) db.prepare('DELETE FROM workout_items WHERE workout_id = ?').run(id);
    return done;
  });
}

/** Gives every step a fresh id (used when copying). */
export function reidItems(items: WorkoutItem[]): WorkoutItem[] {
  return items.map((it) =>
    it.kind === 'superset' ? { ...it, id: randomUUID(), items: it.items.map((c) => ({ ...c, id: randomUUID() })) } : { ...it, id: randomUUID() },
  );
}
