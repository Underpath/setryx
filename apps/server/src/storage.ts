import type { DB } from './db.ts';

/**
 * Roughly how many bytes someone's own data takes: workouts and their steps,
 * custom exercises, routines and sessions with their sets. Close enough for a
 * per-person cap; it reads only that person's rows.
 */
export function storageUsed(db: DB, userId: string): number {
  const row = db
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM(length(name) + length(icon) + COALESCE(length(notes), 0) + 100), 0) FROM workouts WHERE user_id = ?1)
       + (SELECT COALESCE(SUM(length(i.data) + 50), 0) FROM workout_items i JOIN workouts w ON w.id = i.workout_id WHERE w.user_id = ?1)
       + (SELECT COALESCE(SUM(length(name) + length(instructions) + length(equipment) + length(primary_muscles) + length(secondary_muscles) + 100), 0)
            FROM exercises WHERE owner_id = ?1)
       + (SELECT COALESCE(SUM(length(name) + 100), 0) FROM routines WHERE user_id = ?1)
       + (SELECT COUNT(*) * 50 FROM routine_entries e JOIN routines r ON r.id = e.routine_id WHERE r.user_id = ?1)
       + (SELECT COALESCE(SUM(length(snapshot) + length(workout_name) + COALESCE(length(notes), 0) + 100), 0) FROM sessions WHERE user_id = ?1)
       + (SELECT COUNT(*) * 100 FROM set_logs l JOIN sessions s ON s.id = l.session_id WHERE s.user_id = ?1) AS bytes`,
    )
    .get(userId) as { bytes: number };
  return row.bytes;
}
