import type { WorkoutItem } from '@setryx/shared';
import type { DB } from './db.ts';

// Form cues belong to an exercise, one set per person, and show in every
// workout that uses it. Library exercises are shared, so the cues live in
// their own table rather than on the exercise row.

export const MAX_CUES = 2000;

export function getCues(db: DB, userId: string, exerciseId: string): string | null {
  const r = db.prepare('SELECT cues FROM exercise_cues WHERE user_id = ? AND exercise_id = ?').get(userId, exerciseId) as { cues: string } | undefined;
  return r?.cues ?? null;
}

/** Sets or clears (null or blank) a person's cues for an exercise. */
export function setCues(db: DB, userId: string, exerciseId: string, cues: string | null): void {
  const text = cues?.trim().slice(0, MAX_CUES) || null;
  if (!text) {
    db.prepare('DELETE FROM exercise_cues WHERE user_id = ? AND exercise_id = ?').run(userId, exerciseId);
    return;
  }
  db.prepare(
    `INSERT INTO exercise_cues (user_id, exercise_id, cues, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, exercise_id) DO UPDATE SET cues = excluded.cues, updated_at = excluded.updated_at`,
  ).run(userId, exerciseId, text, new Date().toISOString());
}

/** Adds text to an exercise's cues unless it's already in them. */
export function addCues(db: DB, userId: string, exerciseId: string, text: string): void {
  const add = text.trim();
  if (!add) return;
  const cur = getCues(db, userId, exerciseId);
  if (cur?.includes(add)) return;
  setCues(db, userId, exerciseId, cur ? `${cur}\n${add}` : add);
}

/**
 * Steps don't keep cues of their own. Any a client still sends on a step (an
 * import, an older app, the API or MCP) move to the exercise, and the step's
 * copy is dropped.
 */
export function absorbStepCues(db: DB, userId: string, items: WorkoutItem[]): WorkoutItem[] {
  return items.map((it) => {
    if (it.kind === 'superset') return { ...it, items: it.items.map((c) => absorbOne(db, userId, c)) };
    return absorbOne(db, userId, it);
  }) as WorkoutItem[];
}

function absorbOne<T extends { kind: string }>(db: DB, userId: string, step: T): T {
  const s = step as T & { exerciseId?: string; notes?: string | null };
  if (s.kind !== 'exercise' || !s.notes?.trim() || !s.exerciseId) return s.kind === 'exercise' && s.notes ? { ...s, notes: null } : step;
  addCues(db, userId, s.exerciseId, s.notes);
  return { ...s, notes: null };
}
