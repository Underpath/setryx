import type { SessionDetail, SessionSummary, WorkoutItem } from '@setryx/shared';
import type { z } from 'zod';
import type { sessionUploadSchema, setLogSchema } from '@setryx/shared';
import { type DB, now, tx } from './db.ts';

type Upload = z.infer<typeof sessionUploadSchema>;
type SetLog = z.infer<typeof setLogSchema>;

type SessionRow = {
  id: string;
  user_id: string;
  workout_id: string | null;
  workout_name: string;
  icon: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: SessionSummary['status'];
  notes: string | null;
  snapshot: string;
  set_count?: number;
  volume?: number | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Stores a session and its sets. Idempotent: uploading the same id again
 * replaces it, so a device can safely retry after a dropped connection.
 * Returns false if the id belongs to someone else.
 */
export function upsertSession(db: DB, userId: string, id: string, s: Upload): boolean {
  return tx(db, () => {
    const owner = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(id) as { user_id: string } | undefined;
    if (owner && owner.user_id !== userId) return false;
    const ts = now();
    const snapshot = JSON.stringify({ items: s.items, exercises: s.exercises });
    if (owner) {
      db.prepare(
        `UPDATE sessions SET workout_id = ?, workout_name = ?, icon = ?, started_at = ?, ended_at = ?, duration_ms = ?,
                status = ?, notes = ?, snapshot = ?, updated_at = ? WHERE id = ?`,
      ).run(s.workoutId, s.workoutName, s.icon, iso(s.startedAt), iso(s.endedAt), s.durationMs, s.status, s.notes, snapshot, ts, id);
      db.prepare('DELETE FROM set_logs WHERE session_id = ?').run(id);
    } else {
      db.prepare(
        `INSERT INTO sessions (id, user_id, workout_id, workout_name, icon, started_at, ended_at, duration_ms, status, notes, snapshot, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, s.workoutId, s.workoutName, s.icon, iso(s.startedAt), iso(s.endedAt), s.durationMs, s.status, s.notes, snapshot, ts, ts);
    }
    const ins = db.prepare(
      `INSERT INTO set_logs (session_id, step_index, item_id, exercise_id, round, planned_reps, actual_reps, planned_weight, actual_weight,
                             planned_duration_s, actual_duration_s, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of s.logs) {
      ins.run(id, l.stepIndex, l.itemId, l.exerciseId, l.round, l.plannedReps, l.actualReps, l.plannedWeight, l.actualWeight, l.plannedDurationS, l.actualDurationS, iso(l.completedAt));
    }
    return true;
  });
}

function toSummary(r: SessionRow): SessionSummary {
  return {
    id: r.id,
    workoutId: r.workout_id,
    workoutName: r.workout_name,
    icon: r.icon,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    status: r.status,
    setCount: r.set_count ?? 0,
    volumeKg: Math.round((r.volume ?? 0) * 10) / 10,
  };
}

const SUMMARY_SQL = `
  SELECT s.*, COUNT(l.step_index) AS set_count, SUM(COALESCE(l.actual_reps, 0) * COALESCE(l.actual_weight, 0)) AS volume
  FROM sessions s LEFT JOIN set_logs l ON l.session_id = s.id`;

export function listSessions(db: DB, userId: string, limit: number, before?: string): SessionSummary[] {
  const rows = db
    .prepare(`${SUMMARY_SQL} WHERE s.user_id = ? ${before ? 'AND s.started_at < ?' : ''} GROUP BY s.id ORDER BY s.started_at DESC LIMIT ?`)
    .all(...(before ? [userId, before, limit] : [userId, limit])) as SessionRow[];
  return rows.map(toSummary);
}

export function getSession(db: DB, userId: string, id: string): SessionDetail | null {
  const r = db.prepare(`${SUMMARY_SQL} WHERE s.id = ? AND s.user_id = ? GROUP BY s.id`).get(id, userId) as SessionRow | undefined;
  if (!r || !r.id) return null;
  const snap = JSON.parse(r.snapshot) as { items: WorkoutItem[]; exercises: SessionDetail['exercises'] };
  const logs = (
    db.prepare('SELECT * FROM set_logs WHERE session_id = ? ORDER BY step_index').all(id) as {
      step_index: number;
      item_id: string;
      exercise_id: string;
      round: number | null;
      planned_reps: number | null;
      actual_reps: number | null;
      planned_weight: number | null;
      actual_weight: number | null;
      planned_duration_s: number | null;
      actual_duration_s: number | null;
      completed_at: string;
    }[]
  ).map(
    (l): SetLog => ({
      stepIndex: l.step_index,
      itemId: l.item_id,
      exerciseId: l.exercise_id,
      round: l.round,
      plannedReps: l.planned_reps,
      actualReps: l.actual_reps,
      plannedWeight: l.planned_weight,
      actualWeight: l.actual_weight,
      plannedDurationS: l.planned_duration_s,
      actualDurationS: l.actual_duration_s,
      completedAt: new Date(l.completed_at).getTime(),
    }),
  );
  return { ...toSummary(r), notes: r.notes, items: snap.items, exercises: snap.exercises, logs };
}

export function deleteSession(db: DB, userId: string, id: string): boolean {
  return db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}
