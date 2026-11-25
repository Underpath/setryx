import { randomUUID } from 'node:crypto';
import { type PublicUser, type Role, type UserSettings, defaultUserSettings, userSettingsSchema } from '@setryx/shared';
import { type DB, now } from './db.ts';
import { hashPassword } from './passwords.ts';

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  disabled: number;
  settings: string;
  created_at: string;
};

export type UserRecord = PublicUser & { passwordHash: string };

function parseSettings(raw: string): UserSettings {
  try {
    return userSettingsSchema.parse({ ...defaultUserSettings, ...JSON.parse(raw) });
  } catch {
    return defaultUserSettings;
  }
}

function toRecord(r: UserRow): UserRecord {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    disabled: r.disabled === 1,
    createdAt: r.created_at,
    settings: parseSettings(r.settings),
    passwordHash: r.password_hash,
  };
}

export function toPublic(u: UserRecord): PublicUser {
  const { passwordHash: _omit, ...pub } = u;
  return pub;
}

export function countUsers(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function findUserById(db: DB, id: string): UserRecord | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? toRecord(row) : null;
}

export function findUserByUsername(db: DB, username: string): UserRecord | null {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  return row ? toRecord(row) : null;
}

export function listUsers(db: DB): UserRecord[] {
  return (db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map(toRecord);
}

export function countActiveAdmins(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
}

/** Caller must have validated input and checked the username is free. */
export function insertUser(
  db: DB,
  u: { username: string; displayName: string; passwordHash: string; role: Role },
): UserRecord {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, u.username, u.displayName, u.passwordHash, u.role, JSON.stringify(defaultUserSettings), ts, ts);
  return findUserById(db, id)!;
}

export function updateUser(
  db: DB,
  id: string,
  patch: { displayName?: string; role?: Role; disabled?: boolean; settings?: UserSettings; passwordHash?: string },
): UserRecord | null {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.displayName !== undefined) (sets.push('display_name = ?'), vals.push(patch.displayName));
  if (patch.role !== undefined) (sets.push('role = ?'), vals.push(patch.role));
  if (patch.disabled !== undefined) (sets.push('disabled = ?'), vals.push(patch.disabled ? 1 : 0));
  if (patch.settings !== undefined) (sets.push('settings = ?'), vals.push(JSON.stringify(patch.settings)));
  if (patch.passwordHash !== undefined) (sets.push('password_hash = ?'), vals.push(patch.passwordHash));
  if (sets.length) {
    sets.push('updated_at = ?');
    vals.push(now());
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  return findUserById(db, id);
}

export async function setPassword(db: DB, id: string, password: string): Promise<void> {
  updateUser(db, id, { passwordHash: await hashPassword(password) });
}

export function getOpenSignup(db: DB): boolean {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'open_signup'").get() as { value: string } | undefined;
  return row?.value === 'true';
}

export function setOpenSignup(db: DB, open: boolean): void {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('open_signup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    String(open),
  );
}
