import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SignInSession } from '@setryx/shared';
import { type DB, now } from './db.ts';

export const SESSION_COOKIE = 'setryx_session';
const DAY = 86_400_000;
/** Last-used times are written at most this often, to keep writes down. */
const TOUCH_EVERY = 5 * 60_000;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

/** The admin-set rules for how long sign-ins last (see Settings → Limits). */
export type SessionPolicy = { sessionIdleDays: number; sessionMaxDays: number | null; maxSessionsPerUser: number };

/** When a session stops working: after the idle time without use, and never past the maximum lifetime. */
function expiryOf(createdAt: number, lastUsedAt: number, p: SessionPolicy): number {
  const idle = lastUsedAt + p.sessionIdleDays * DAY;
  return p.sessionMaxDays === null ? idle : Math.min(idle, createdAt + p.sessionMaxDays * DAY);
}

/** Creates a session and returns the raw token (only its hash is stored). Past the per-person cap, the longest unused go. */
export function createSession(db: DB, userId: string, userAgent: string | undefined, p: SessionPolicy): { token: string; expiresAt: Date } {
  const token = newToken();
  const t = Date.now();
  const expiresAt = new Date(expiryOf(t, t, p));
  const at = new Date(t).toISOString();
  db.prepare('INSERT INTO auth_sessions (id_hash, id, user_id, user_agent, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    sha256(token),
    randomUUID(),
    userId,
    userAgent?.slice(0, 300) ?? null,
    at,
    at,
    expiresAt.toISOString(),
  );
  db.prepare(
    `DELETE FROM auth_sessions WHERE user_id = ? AND id_hash NOT IN
       (SELECT id_hash FROM auth_sessions WHERE user_id = ? ORDER BY last_used_at DESC, created_at DESC LIMIT ?)`,
  ).run(userId, userId, p.maxSessionsPerUser);
  return { token, expiresAt };
}

/**
 * Looks up a session by raw token. Returns the user id and, when the expiry
 * moved on (it slides with use, up to the maximum lifetime), the new expiry so
 * the cookie can be refreshed. Policy changes apply to existing sessions too.
 */
export function resolveSession(db: DB, token: string, p: SessionPolicy): { userId: string; renewedUntil: Date | null } | null {
  const idHash = sha256(token);
  const row = db.prepare('SELECT user_id, created_at, last_used_at, expires_at FROM auth_sessions WHERE id_hash = ?').get(idHash) as
    | { user_id: string; created_at: string; last_used_at: string | null; expires_at: string }
    | undefined;
  if (!row) return null;
  const t = Date.now();
  const created = Date.parse(row.created_at);
  const lastUsed = Date.parse(row.last_used_at ?? row.created_at);
  if (expiryOf(created, lastUsed, p) <= t || Date.parse(row.expires_at) <= t) {
    db.prepare('DELETE FROM auth_sessions WHERE id_hash = ?').run(idHash);
    return null;
  }
  if (t - lastUsed < TOUCH_EVERY) return { userId: row.user_id, renewedUntil: null };
  const next = expiryOf(created, t, p);
  db.prepare('UPDATE auth_sessions SET last_used_at = ?, expires_at = ? WHERE id_hash = ?').run(new Date(t).toISOString(), new Date(next).toISOString(), idHash);
  // Refresh the cookie only when its expiry moves by more than a day.
  const renewed = Math.abs(next - Date.parse(row.expires_at)) > DAY ? new Date(next) : null;
  return { userId: row.user_id, renewedUntil: renewed };
}

export function deleteSession(db: DB, token: string): void {
  db.prepare('DELETE FROM auth_sessions WHERE id_hash = ?').run(sha256(token));
}

export function deleteUserSessions(db: DB, userId: string, exceptToken?: string): void {
  if (exceptToken) {
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND id_hash != ?').run(userId, sha256(exceptToken));
  } else {
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  }
}

/** The places someone is signed in, most recently used first. */
export function listUserSessions(db: DB, userId: string, currentToken: string | null): SignInSession[] {
  const current = currentToken ? sha256(currentToken) : null;
  const rows = db
    .prepare('SELECT id, id_hash, user_agent, created_at, last_used_at FROM auth_sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC')
    .all(userId, now()) as { id: string; id_hash: string; user_agent: string | null; created_at: string; last_used_at: string | null }[];
  return rows.map((r) => ({ id: r.id, userAgent: r.user_agent, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? r.created_at, current: r.id_hash === current }));
}

export function deleteUserSessionById(db: DB, userId: string, id: string): boolean {
  return db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}

export function purgeExpiredSessions(db: DB): void {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now());
}
