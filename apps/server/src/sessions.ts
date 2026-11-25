import { createHash, randomBytes } from 'node:crypto';
import { type DB, now } from './db.ts';

export const SESSION_COOKIE = 'setryx_session';
const SESSION_DAYS = 30;
const RENEW_BELOW_DAYS = 15;
const DAY = 86_400_000;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

/** Creates a session and returns the raw token (only its hash is stored). */
export function createSession(db: DB, userId: string, userAgent: string | undefined): { token: string; expiresAt: Date } {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY);
  db.prepare('INSERT INTO auth_sessions (id_hash, user_id, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    userId,
    userAgent?.slice(0, 300) ?? null,
    now(),
    expiresAt.toISOString(),
  );
  return { token, expiresAt };
}

/**
 * Looks up a session by raw token. Returns the user id and, when the session
 * was extended (sliding expiry), the new expiry so the cookie can be refreshed.
 */
export function resolveSession(db: DB, token: string): { userId: string; renewedUntil: Date | null } | null {
  const idHash = sha256(token);
  const row = db.prepare('SELECT user_id, expires_at FROM auth_sessions WHERE id_hash = ?').get(idHash) as
    | { user_id: string; expires_at: string }
    | undefined;
  if (!row) return null;
  const expires = new Date(row.expires_at).getTime();
  if (expires <= Date.now()) {
    db.prepare('DELETE FROM auth_sessions WHERE id_hash = ?').run(idHash);
    return null;
  }
  let renewedUntil: Date | null = null;
  if (expires - Date.now() < RENEW_BELOW_DAYS * DAY) {
    renewedUntil = new Date(Date.now() + SESSION_DAYS * DAY);
    db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id_hash = ?').run(renewedUntil.toISOString(), idHash);
  }
  return { userId: row.user_id, renewedUntil };
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

export function purgeExpiredSessions(db: DB): void {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now());
}
