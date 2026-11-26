import { accessSync, constants, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BackupFile, type BackupSettings, backupSettingsSchema, defaultBackupSettings } from '@setryx/shared';
import type { DB } from './db.ts';

// Copies of the database for the admin's own volume backups to pick up.
//   setryx-latest.db                  refreshed when something changed, always complete
//   setryx-before-vN-<time>.db        taken just before an update changes the database
//   setryx-manual-<time>.db           "Make a copy now"
// Every copy is written under a temporary name and then renamed, so a backup
// tool can never catch one half-written. Where they go and how many are kept
// are admin settings (stored in app_settings).

export const LATEST = 'setryx-latest.db';
const KEY = 'backup_settings';

export function readBackupSettings(db: DB, dataDir: string): BackupSettings {
  const fallback = defaultBackupSettings(dataDir);
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (!row) return fallback;
    const parsed = backupSettingsSchema.safeParse({ ...fallback, ...JSON.parse(row.value) });
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback; // app_settings may not exist yet on a brand-new database
  }
}

/** Throws a readable message if the folder can't be created or written to. */
export function checkFolder(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    const probe = join(dir, '.setryx-write-test');
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
  } catch {
    throw new Error(`Setryx can’t write to ${dir}. Check the folder exists in the container and Setryx can write to it.`);
  }
}

/** A consistent copy of the live database, written atomically. */
export function copyDatabase(db: DB, file: string): void {
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  renameSync(tmp, file);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const kindOf = (f: string): BackupFile['kind'] | null =>
  f === LATEST ? 'latest' : /^setryx-before-v\d+-.+\.db$/.test(f) ? 'before-update' : /^setryx-manual-.+\.db$/.test(f) ? 'manual' : null;
const stampOf = (f: string) => f.replace(/^setryx-(before-v\d+|manual)-/, '');

/** Keeps the newest `keep` files of one kind. */
function prune(dir: string, kind: 'before-update' | 'manual', keep: number): void {
  const files = readdirSync(dir)
    .filter((f) => kindOf(f) === kind)
    .sort((a, b) => stampOf(a).localeCompare(stampOf(b)));
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f), { force: true });
}

/** Before migrating to `toVersion`: keep a copy of the database as it was. Returns the file. */
export function backupBeforeUpdate(db: DB, dataDir: string, toVersion: number): string {
  const s = readBackupSettings(db, dataDir);
  mkdirSync(s.dir, { recursive: true });
  const file = join(s.dir, `setryx-before-v${toVersion}-${stamp()}.db`);
  copyDatabase(db, file);
  prune(s.dir, 'before-update', s.keep);
  return file;
}

export function listBackups(dir: string): BackupFile[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const kind = kindOf(name);
      if (!kind) return [];
      try {
        const st = statSync(join(dir, name));
        return [{ name, kind, bytes: st.size, modifiedAt: st.mtime.toISOString() }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

const changes = (db: DB) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

/** Runs the up-to-date copy on its timer and applies setting changes while running. */
export class Backups {
  private timer: ReturnType<typeof setInterval> | null = null;
  private copiedAt = -1;
  private copiedDir = '';
  readonly db: DB;
  readonly dataDir: string;

  constructor(db: DB, dataDir: string) {
    this.db = db;
    this.dataDir = dataDir;
  }

  settings(): BackupSettings {
    return readBackupSettings(this.db, this.dataDir);
  }

  /** Saves new settings after checking the folder is writable, then restarts the timer. */
  update(next: BackupSettings): BackupSettings {
    checkFolder(next.dir);
    this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(next));
    const s = this.settings();
    prune(s.dir, 'before-update', s.keep);
    prune(s.dir, 'manual', s.keep);
    this.start();
    return s;
  }

  /** Refreshes setryx-latest.db if anything changed (or the folder moved). */
  flush(): void {
    const s = this.settings();
    if (!s.latestEveryMinutes) return;
    const n = changes(this.db);
    if (n === this.copiedAt && s.dir === this.copiedDir) return;
    mkdirSync(s.dir, { recursive: true });
    copyDatabase(this.db, join(s.dir, LATEST));
    this.copiedAt = n;
    this.copiedDir = s.dir;
  }

  copyNow(): BackupFile {
    const s = this.settings();
    checkFolder(s.dir);
    const name = `setryx-manual-${stamp()}.db`;
    copyDatabase(this.db, join(s.dir, name));
    prune(s.dir, 'manual', s.keep);
    return listBackups(s.dir).find((f) => f.name === name)!;
  }

  start(): void {
    this.stop();
    const s = this.settings();
    if (!s.latestEveryMinutes) return;
    try {
      this.flush(); // right away, so the file exists and matches the settings
    } catch {
      /* folder unavailable: try again on the timer */
    }
    this.timer = setInterval(() => {
      try {
        this.flush();
      } catch {
        /* disk full or folder gone: try again next time */
      }
    }, s.latestEveryMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
