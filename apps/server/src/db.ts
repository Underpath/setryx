import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { migrations } from './migrations.ts';
import { seedExercises } from './exercises.ts';

export type DB = DatabaseSync;

export function openDb(dataDir: string | ':memory:'): DB {
  const db = new DatabaseSync(dataDir === ':memory:' ? ':memory:' : join(dataDir, 'setryx.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  seedExercises(db);
  return db;
}

function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, now());
    });
  }
}

const depth = new WeakMap<DB, number>();

/**
 * Runs fn inside a transaction (node:sqlite has no helper for this).
 * Nested calls use savepoints, so a helper that opens its own transaction can
 * be called from inside a bigger one and everything still rolls back together.
 */
export function tx<T>(db: DB, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const sp = `sp${level}`;
  db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth.set(db, level + 1);
  try {
    const result = fn();
    db.exec(level === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  } finally {
    depth.set(db, level);
  }
}

export const now = () => new Date().toISOString();
