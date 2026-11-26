import { type LimitSettings, defaultLimitSettings, limitSettingsSchema } from '@setryx/shared';
import type { DB } from './db.ts';

const KEY = 'limits';

/** The admin-set limits, kept in app_settings and cached in memory (one server process). */
export class Limits {
  private cached: LimitSettings | null = null;
  private readonly db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  get(): LimitSettings {
    if (this.cached) return this.cached;
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    let stored: unknown = {};
    try {
      stored = row ? JSON.parse(row.value) : {};
    } catch {
      // A damaged value falls back to the defaults.
    }
    const parsed = limitSettingsSchema.safeParse({ ...defaultLimitSettings, ...(stored as object) });
    return (this.cached = parsed.success ? parsed.data : defaultLimitSettings);
  }

  set(settings: LimitSettings): LimitSettings {
    this.db
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(KEY, JSON.stringify(settings));
    this.cached = null;
    return this.get();
  }
}

export type Taken = { ok: true; remaining: number } | { ok: false; retryAfterS: number };

/**
 * A token bucket per key: it holds up to `perMinute` requests and refills
 * steadily, so a burst of a minute's worth is fine and a steady stream above
 * the limit is slowed to it. In memory, so a restart starts everyone afresh.
 */
export class RateLimiter {
  private buckets = new Map<string, { left: number; at: number }>();
  private calls = 0;

  take(key: string, perMinute: number, cost = 1, now = Date.now()): Taken {
    const left = this.left(key, perMinute, now);
    if (++this.calls % 1000 === 0) this.sweep(now);
    if (left < cost) {
      this.buckets.set(key, { left, at: now });
      return this.refused(left, perMinute, cost);
    }
    this.buckets.set(key, { left: left - cost, at: now });
    return { ok: true, remaining: Math.floor(left - cost) };
  }

  /** Gives back what `take` took, e.g. when the attempt turned out fine. */
  refund(key: string, perMinute: number, cost = 1, now = Date.now()): void {
    this.buckets.set(key, { left: Math.min(perMinute, this.left(key, perMinute, now) + cost), at: now });
  }

  /** Whether `cost` could be taken now, without taking it. */
  peek(key: string, perMinute: number, cost = 1, now = Date.now()): Taken {
    const left = this.left(key, perMinute, now);
    return left < cost ? this.refused(left, perMinute, cost) : { ok: true, remaining: Math.floor(left - cost) };
  }

  private left(key: string, perMinute: number, now: number): number {
    const b = this.buckets.get(key);
    return b ? Math.min(perMinute, b.left + ((now - b.at) * perMinute) / 60_000) : perMinute;
  }

  private refused(left: number, perMinute: number, cost: number): Taken {
    return { ok: false, retryAfterS: Math.max(1, Math.ceil(((cost - left) * 60) / perMinute)) };
  }

  /** Forget buckets idle long enough to be full again. */
  private sweep(now: number): void {
    for (const [key, b] of this.buckets) if (now - b.at > 60_000) this.buckets.delete(key);
  }
}

/** How long after the last refusal an account still counts as under attack. */
const WATCH_MS = 15 * 60_000;

/**
 * Accounts whose shared wrong-password count ran out, i.e. somebody without a
 * known device kept guessing. Shown to admins and logged, at most every 10 minutes per account.
 */
export class LockoutWatch {
  private seen = new Map<string, { since: number; lastAt: number; refused: number; loggedAt: number }>();

  /** Records a refusal; true when it's worth a log line. */
  refused(userId: string, now = Date.now()): boolean {
    const s = this.seen.get(userId);
    if (!s || now - s.lastAt > WATCH_MS) {
      this.seen.set(userId, { since: now, lastAt: now, refused: 1, loggedAt: now });
      return true;
    }
    s.lastAt = now;
    s.refused++;
    if (now - s.loggedAt < 10 * 60_000) return false;
    s.loggedAt = now;
    return true;
  }

  count(userId: string): number {
    return this.seen.get(userId)?.refused ?? 0;
  }

  /** Accounts refused within the last 15 minutes. */
  active(now = Date.now()): { userId: string; since: number; lastAt: number; refused: number }[] {
    const out = [];
    for (const [userId, s] of this.seen) {
      if (now - s.lastAt > WATCH_MS) this.seen.delete(userId);
      else out.push({ userId, since: s.since, lastAt: s.lastAt, refused: s.refused });
    }
    return out;
  }
}
