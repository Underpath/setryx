import { type DB, now } from './db.ts';
import { newToken, sha256 } from './sessions.ts';

/**
 * Known devices: browsers that have signed in to an account with its password
 * before. Each browser keeps one random id in a long-lived cookie; only its hash
 * is stored, once per account it signed in to (a shared browser can be known to
 * several). Sign-ins from a known device are counted on their own, so strangers
 * guessing an account's password can't lock out the devices its owner uses.
 */
export const DEVICE_COOKIE = 'setryx_device';
const DAY = 86_400_000;
/** A device not used to sign in for this long is forgotten. */
export const DEVICE_KEEP_DAYS = 365;
/** At most this many known devices per account; past it, the longest unused go. */
const MAX_PER_USER = 20;

export const newDeviceId = newToken;

/** The stored hash when this device id is known to this account, otherwise null. */
export function knownDevice(db: DB, deviceId: string, userId: string): string | null {
  const hash = sha256(deviceId);
  const row = db.prepare('SELECT 1 FROM known_devices WHERE id_hash = ? AND user_id = ? AND last_used_at > ?').get(
    hash,
    userId,
    new Date(Date.now() - DEVICE_KEEP_DAYS * DAY).toISOString(),
  );
  return row ? hash : null;
}

/** Records a successful password sign-in from this device. */
export function rememberDevice(db: DB, deviceId: string, userId: string): void {
  const at = now();
  db.prepare(
    `INSERT INTO known_devices (id_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id_hash, user_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
  ).run(sha256(deviceId), userId, at, at);
  db.prepare(
    `DELETE FROM known_devices WHERE user_id = ? AND id_hash NOT IN
       (SELECT id_hash FROM known_devices WHERE user_id = ? ORDER BY last_used_at DESC LIMIT ?)`,
  ).run(userId, userId, MAX_PER_USER);
}

/** Forgets an account's known devices, except optionally this one. */
export function forgetDevices(db: DB, userId: string, exceptDeviceId?: string | null): void {
  if (exceptDeviceId) {
    db.prepare('DELETE FROM known_devices WHERE user_id = ? AND id_hash != ?').run(userId, sha256(exceptDeviceId));
  } else {
    db.prepare('DELETE FROM known_devices WHERE user_id = ?').run(userId);
  }
}

export function purgeOldDevices(db: DB): void {
  db.prepare('DELETE FROM known_devices WHERE last_used_at <= ?').run(new Date(Date.now() - DEVICE_KEEP_DAYS * DAY).toISOString());
}
