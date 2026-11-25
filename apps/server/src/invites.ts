import { randomUUID } from 'node:crypto';
import type { Invite } from '@setryx/shared';
import { type DB, now } from './db.ts';
import { newToken, sha256 } from './sessions.ts';

type InviteRow = {
  id: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_by: string | null;
  used_at: string | null;
};

function toInvite(r: InviteRow & { creator: string; used_by_name: string | null }): Invite {
  const status = r.used_at ? 'used' : new Date(r.expires_at).getTime() <= Date.now() ? 'expired' : 'open';
  return {
    id: r.id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    createdBy: r.creator,
    usedBy: r.used_by_name,
    usedAt: r.used_at,
    status,
  };
}

/** Returns the raw token once; only its hash is stored. */
export function createInvite(db: DB, createdBy: string, expiresInDays: number): { invite: Invite; token: string } {
  const id = randomUUID();
  const token = newToken();
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
  db.prepare('INSERT INTO invites (id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    sha256(token),
    createdBy,
    now(),
    expiresAt,
  );
  return { invite: listInvites(db).find((i) => i.id === id)!, token };
}

export function listInvites(db: DB): Invite[] {
  const rows = db
    .prepare(
      `SELECT i.*, c.username AS creator, u.username AS used_by_name
       FROM invites i
       JOIN users c ON c.id = i.created_by
       LEFT JOIN users u ON u.id = i.used_by
       ORDER BY i.created_at DESC`,
    )
    .all() as (InviteRow & { creator: string; used_by_name: string | null })[];
  return rows.map(toInvite);
}

/** Returns the invite id if the token is open (not used, not expired). */
export function findOpenInvite(db: DB, token: string): string | null {
  const row = db
    .prepare('SELECT id FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .get(sha256(token), now()) as { id: string } | undefined;
  return row?.id ?? null;
}

export function markInviteUsed(db: DB, inviteId: string, userId: string): void {
  db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?').run(userId, now(), inviteId);
}

export function deleteInvite(db: DB, id: string): boolean {
  return db.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL').run(id).changes > 0;
}
