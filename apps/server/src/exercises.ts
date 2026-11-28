import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Exercise, type ExerciseType, normalizeName } from '@setryx/shared';
import { type DB, now, tx } from './db.ts';

type ExerciseRow = {
  id: string;
  owner_id: string | null;
  name: string;
  category: string | null;
  default_type: ExerciseType;
  primary_muscles: string;
  secondary_muscles: string;
  equipment: string;
  instructions: string;
  images: string;
  archived: number;
  /** This person's form cues, from exercise_cues; absent where not joined. */
  cues?: string | null;
};

const arr = (s: string): string[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

function toExercise(r: ExerciseRow): Exercise {
  return {
    id: r.id,
    name: r.name,
    isCustom: r.owner_id !== null,
    category: r.category,
    defaultType: r.default_type,
    primaryMuscles: arr(r.primary_muscles),
    secondaryMuscles: arr(r.secondary_muscles),
    equipment: arr(r.equipment),
    instructions: arr(r.instructions),
    images: arr(r.images),
    cues: r.cues ?? null,
  };
}

// ── Seed (library) ──

type SeedFile = {
  source: string;
  exercises: {
    id: string;
    name: string;
    category: string | null;
    defaultType: ExerciseType;
    equipment: string[];
    primaryMuscles: string[];
    secondaryMuscles: string[];
    instructions: string[];
    images: string[];
  }[];
};

const SEED_PATH = new URL('../seed/exercises.json', import.meta.url);

/**
 * Loads the bundled exercise library. Runs at every boot but only writes when
 * the seed file changed. Seeded rows are upserted by source id, so ids stay
 * stable and workouts keep pointing at them.
 */
export function seedExercises(db: DB): { changed: boolean; count: number } {
  const raw = readFileSync(SEED_PATH, 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex');
  const current = db.prepare("SELECT value FROM app_settings WHERE key = 'exercise_seed'").get() as { value: string } | undefined;
  const seed = JSON.parse(raw) as SeedFile;
  if (current?.value === hash) return { changed: false, count: seed.exercises.length };

  const ts = now();
  const upsert = db.prepare(`
    INSERT INTO exercises (id, owner_id, name, name_norm, category, default_type, primary_muscles, secondary_muscles,
                           equipment, instructions, images, source, source_id, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id) DO UPDATE SET
      name = excluded.name, name_norm = excluded.name_norm, category = excluded.category,
      default_type = excluded.default_type, primary_muscles = excluded.primary_muscles,
      secondary_muscles = excluded.secondary_muscles, equipment = excluded.equipment,
      instructions = excluded.instructions, images = excluded.images, archived = 0, updated_at = excluded.updated_at`);
  tx(db, () => {
    for (const e of seed.exercises) {
      upsert.run(
        `lib:${e.id}`, e.name, normalizeName(e.name), e.category, e.defaultType,
        JSON.stringify(e.primaryMuscles), JSON.stringify(e.secondaryMuscles), JSON.stringify(e.equipment),
        JSON.stringify(e.instructions), JSON.stringify(e.images), seed.source, e.id, ts, ts,
      );
    }
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('exercise_seed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hash);
  });
  return { changed: true, count: seed.exercises.length };
}

// ── Queries ──

/** Exercises the user can see: the library plus their own custom ones. */
const VISIBLE = '(owner_id IS NULL OR owner_id = ?)';
/** Exercise rows with this person's cues. Takes the user id as its first parameter. */
const WITH_CUES = 'SELECT exercises.*, c.cues AS cues FROM exercises LEFT JOIN exercise_cues c ON c.exercise_id = exercises.id AND c.user_id = ?';

export type ExerciseQuery = { q?: string; muscle?: string; equipment?: string; custom?: boolean; limit: number; offset: number };

export function searchExercises(db: DB, userId: string, query: ExerciseQuery): { exercises: Exercise[]; total: number } {
  const where = [VISIBLE, 'archived = 0'];
  const params: (string | number)[] = [userId];
  if (query.q) {
    for (const word of normalizeName(query.q).split(' ').filter(Boolean)) {
      where.push('name_norm LIKE ?');
      params.push(`%${word}%`);
    }
  }
  if (query.muscle) {
    where.push('(primary_muscles LIKE ? OR secondary_muscles LIKE ?)');
    params.push(`%"${query.muscle}"%`, `%"${query.muscle}"%`);
  }
  if (query.equipment) {
    where.push('equipment LIKE ?');
    params.push(`%"${query.equipment}"%`);
  }
  if (query.custom) where.push('owner_id IS NOT NULL');
  const whereSql = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM exercises WHERE ${whereSql}`).get(...params) as { n: number }).n;
  // Custom exercises first, then names that start with the search, then alphabetical.
  const first = query.q ? normalizeName(query.q) : '';
  const rows = db
    .prepare(
      `${WITH_CUES} WHERE ${whereSql}
       ORDER BY (owner_id IS NULL), (name_norm NOT LIKE ?), name COLLATE NOCASE
       LIMIT ? OFFSET ?`,
    )
    .all(userId, ...params, `${first}%`, query.limit, query.offset) as ExerciseRow[];
  return { exercises: rows.map(toExercise), total };
}

export function listAllVisible(db: DB, userId: string): Exercise[] {
  return (db.prepare(`${WITH_CUES} WHERE ${VISIBLE} AND archived = 0`).all(userId, userId) as ExerciseRow[]).map(toExercise);
}

export function exerciseFacets(db: DB, userId: string): { muscles: string[]; equipment: string[] } {
  const rows = db.prepare(`SELECT primary_muscles, equipment FROM exercises WHERE ${VISIBLE} AND archived = 0`).all(userId) as {
    primary_muscles: string;
    equipment: string;
  }[];
  const muscles = new Set<string>();
  const equipment = new Set<string>();
  for (const r of rows) {
    arr(r.primary_muscles).forEach((m) => muscles.add(m));
    arr(r.equipment).forEach((e) => equipment.add(e));
  }
  const sort = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return { muscles: sort(muscles), equipment: sort(equipment) };
}

/** Includes archived rows: a workout may still point at an exercise its owner removed. */
export function getExercisesByIds(db: DB, userId: string, ids: string[]): Record<string, Exercise> {
  const out: Record<string, Exercise> = {};
  if (!ids.length) return out;
  const rows = db
    .prepare(`${WITH_CUES} WHERE ${VISIBLE} AND exercises.id IN (${ids.map(() => '?').join(',')})`)
    .all(userId, userId, ...ids) as ExerciseRow[];
  for (const r of rows) out[r.id] = toExercise(r);
  return out;
}

export function getExercise(db: DB, userId: string, id: string): (Exercise & { ownerId: string | null; archived: boolean }) | null {
  const r = db.prepare(`${WITH_CUES} WHERE ${VISIBLE} AND exercises.id = ?`).get(userId, userId, id) as ExerciseRow | undefined;
  return r ? { ...toExercise(r), ownerId: r.owner_id, archived: r.archived === 1 } : null;
}

export type CustomExerciseFields = {
  name: string;
  defaultType: ExerciseType;
  category: string | null;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  equipment: string[];
  instructions: string[];
};

export function insertCustomExercise(db: DB, userId: string, f: CustomExerciseFields): Exercise {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO exercises (id, owner_id, name, name_norm, category, default_type, primary_muscles, secondary_muscles,
                            equipment, instructions, images, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(
    id, userId, f.name, normalizeName(f.name), f.category, f.defaultType, JSON.stringify(f.primaryMuscles),
    JSON.stringify(f.secondaryMuscles), JSON.stringify(f.equipment), JSON.stringify(f.instructions), ts, ts,
  );
  return getExercise(db, userId, id)!;
}

export function updateCustomExercise(db: DB, userId: string, id: string, f: CustomExerciseFields): Exercise | null {
  const res = db
    .prepare(
      `UPDATE exercises SET name = ?, name_norm = ?, category = ?, default_type = ?, primary_muscles = ?, secondary_muscles = ?,
              equipment = ?, instructions = ?, updated_at = ?
       WHERE id = ? AND owner_id = ?`,
    )
    .run(
      f.name, normalizeName(f.name), f.category, f.defaultType, JSON.stringify(f.primaryMuscles), JSON.stringify(f.secondaryMuscles),
      JSON.stringify(f.equipment), JSON.stringify(f.instructions), now(), id, userId,
    );
  return res.changes ? getExercise(db, userId, id) : null;
}

/** Soft delete: workouts that use it keep working, it just disappears from the library. */
export function archiveCustomExercise(db: DB, userId: string, id: string): boolean {
  return db.prepare('UPDATE exercises SET archived = 1, updated_at = ? WHERE id = ? AND owner_id = ? AND archived = 0').run(now(), id, userId).changes > 0;
}

export function customExercisesOf(db: DB, userId: string): Exercise[] {
  return (db.prepare(`${WITH_CUES} WHERE owner_id = ? AND archived = 0 ORDER BY name COLLATE NOCASE`).all(userId, userId) as ExerciseRow[]).map(toExercise);
}
