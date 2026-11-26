import { randomUUID } from 'node:crypto';
import type { ApiToken, ApiTokenScope } from '@setryx/shared';
import { type DB, now } from './db.ts';
import { newToken, sha256 } from './sessions.ts';

// Personal API tokens: one person's access to their own training data, for
// scripts and AI agents. A token never reaches account, admin or server
// settings; see tokenMayUse below for exactly what it can do.

const PREFIX = 'setryx_';
const DAY = 86_400_000;
/** Don't write "last used" on every request. */
const TOUCH_EVERY_MS = 60_000;

type Row = { id: string; name: string; scope: ApiTokenScope; hint: string; created_at: string; last_used_at: string | null; expires_at: string | null };
const toApi = (r: Row): ApiToken => ({ id: r.id, name: r.name, scope: r.scope, hint: r.hint, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at });

/** Creates a token and returns it in full; only its hash is stored, so this is the one time it's shown. */
export function createApiToken(db: DB, userId: string, input: { name: string; scope: ApiTokenScope; expiresInDays: number | null }): { token: ApiToken; secret: string } {
  const secret = PREFIX + newToken();
  const row: Row = {
    id: randomUUID(),
    name: input.name,
    scope: input.scope,
    hint: `${secret.slice(0, PREFIX.length + 4)}…`,
    created_at: now(),
    last_used_at: null,
    expires_at: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * DAY).toISOString() : null,
  };
  db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, hint, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    row.id,
    userId,
    row.name,
    sha256(secret),
    row.hint,
    row.scope,
    row.created_at,
    row.expires_at,
  );
  return { token: toApi(row), secret };
}

export function listApiTokens(db: DB, userId: string): ApiToken[] {
  const rows = db
    .prepare('SELECT id, name, scope, hint, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as Row[];
  return rows.map(toApi);
}

export function deleteApiToken(db: DB, userId: string, id: string): boolean {
  return db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

export function deleteUserApiTokens(db: DB, userId: string): void {
  db.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(userId);
}

export type ResolvedToken = { id: string; userId: string; scope: ApiTokenScope };

/** Looks a token up by its full value. Expired tokens are removed and don't resolve. */
export function resolveApiToken(db: DB, secret: string): ResolvedToken | null {
  if (!secret.startsWith(PREFIX) || secret.length > 200) return null;
  const row = db.prepare('SELECT id, user_id, scope, last_used_at, expires_at FROM api_tokens WHERE token_hash = ?').get(sha256(secret)) as
    | { id: string; user_id: string; scope: ApiTokenScope; last_used_at: string | null; expires_at: string | null }
    | undefined;
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM api_tokens WHERE id = ?').run(row.id);
    return null;
  }
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > TOUCH_EVERY_MS) {
    db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  }
  return { id: row.id, userId: row.user_id, scope: row.scope };
}

// ── What a token may do ──
// Your own training data only: exercises, workouts, routines, sessions and
// stats, plus reading your own profile. Never sign-in, account settings,
// passwords, tokens, import/export, photos, or anything under /admin.

const READ = new Set(['GET', 'HEAD']);
const DATA = /^\/api\/v1\/(exercises|workouts|routines|sessions|stats)(\/|$)/;
const READ_ONLY = new Set(['/api/v1/auth/me', '/api/v1/openapi.json']);

export type TokenAccess = 'ok' | 'not_allowed' | 'read_only';

/** `route` is the matched route pattern, like /api/v1/workouts/:id. */
export function tokenMayUse(scope: ApiTokenScope, method: string, route: string): TokenAccess {
  const reading = READ.has(method);
  if (READ_ONLY.has(route)) return reading ? 'ok' : 'not_allowed';
  if (!DATA.test(route)) return 'not_allowed';
  if (!reading && scope !== 'write') return 'read_only';
  return 'ok';
}
