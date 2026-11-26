import { startOfWeek } from './routines.ts';

// Stats are computed on the device from plain session and set data, so dates
// follow the user's own time zone and week start.

/** Estimated one-rep max (Epley). Null without both a weight and reps. */
export function e1rm(weight: number | null | undefined, reps: number | null | undefined): number | null {
  if (!weight || !reps || weight <= 0 || reps <= 0) return null;
  const v = reps === 1 ? weight : weight * (1 + reps / 30);
  return Math.round(v * 10) / 10;
}

/** Local calendar date as YYYY-MM-DD. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

export type SessionPoint = { startedAt: string; durationMs: number };

export type WeekSummary = { start: string; sessions: number; durationMs: number };

export type WeeklyStats = {
  /** Oldest first, ending with this week. */
  weeks: WeekSummary[];
  /** Weeks in a row with at least one session. This week counts once it has one; until then the streak runs to last week. */
  current: number;
  best: number;
  thisWeek: WeekSummary;
};

export function weeklyStats(sessions: SessionPoint[], now: Date, weekStart = 0, weeks = 12): WeeklyStats {
  const byWeek = new Map<string, WeekSummary>();
  for (const s of sessions) {
    const k = dayKey(startOfWeek(new Date(s.startedAt), weekStart));
    const w = byWeek.get(k) ?? { start: k, sessions: 0, durationMs: 0 };
    w.sessions++;
    w.durationMs += s.durationMs;
    byWeek.set(k, w);
  }
  const thisStart = startOfWeek(now, weekStart);
  const list: WeekSummary[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const k = dayKey(addDays(thisStart, -7 * i));
    list.push(byWeek.get(k) ?? { start: k, sessions: 0, durationMs: 0 });
  }

  // Current streak: back from this week (or last week, if this one is still empty).
  let current = 0;
  let cursor = byWeek.has(dayKey(thisStart)) ? thisStart : addDays(thisStart, -7);
  while (byWeek.has(dayKey(cursor))) {
    current++;
    cursor = addDays(cursor, -7);
  }

  // Best streak: walk every week that had a session, oldest first.
  const keys = [...byWeek.keys()].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const k of keys) {
    run = prev && dayKey(addDays(new Date(...ymd(prev)), 7)) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }
  return { weeks: list, current, best: Math.max(best, current), thisWeek: list[list.length - 1]! };
}

const ymd = (k: string): [number, number, number] => {
  const [y, m, d] = k.split('-').map(Number) as [number, number, number];
  return [y, m - 1, d];
};

export type DailyStreak = { current: number; best: number; today: boolean };

/** Days in a row with a session. Today counts once it has one; until then the streak runs to yesterday. */
export function dailyStreak(sessions: SessionPoint[], now: Date): DailyStreak {
  const days = new Set(sessions.map((s) => dayKey(new Date(s.startedAt))));
  const todayKey = dayKey(now);
  let current = 0;
  let cursor = days.has(todayKey) ? new Date(now) : addDays(now, -1);
  while (days.has(dayKey(cursor))) {
    current++;
    cursor = addDays(cursor, -1);
  }
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const k of [...days].sort()) {
    run = prev && dayKey(addDays(new Date(...ymd(prev)), 1)) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }
  return { current, best: Math.max(best, current), today: days.has(todayKey) };
}

export type CalendarDay = { key: string; date: Date; sessions: number; durationMs: number; future: boolean };

/** A grid of weeks (oldest first), each Monday-or-whatever first, for a heatmap. */
export function calendarWeeks(sessions: SessionPoint[], now: Date, weekStart = 0, weeks = 26): CalendarDay[][] {
  const byDay = new Map<string, { sessions: number; durationMs: number }>();
  for (const s of sessions) {
    const k = dayKey(new Date(s.startedAt));
    const v = byDay.get(k) ?? { sessions: 0, durationMs: 0 };
    v.sessions++;
    v.durationMs += s.durationMs;
    byDay.set(k, v);
  }
  const todayKey = dayKey(now);
  const first = addDays(startOfWeek(now, weekStart), -7 * (weeks - 1));
  const grid: CalendarDay[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(first, w * 7 + d);
      const key = dayKey(date);
      const v = byDay.get(key);
      col.push({ key, date, sessions: v?.sessions ?? 0, durationMs: v?.durationMs ?? 0, future: key > todayKey });
    }
    grid.push(col);
  }
  return grid;
}

// ── Exercises ──

export type ExerciseSet = { reps: number | null; weight: number | null; durationS: number | null };
export type ExerciseHistoryEntry = { sessionId: string; startedAt: string; workoutName: string; sets: ExerciseSet[] };

export type Bests = {
  /** Heaviest weight lifted for at least one rep. */
  weight: number | null;
  e1rm: number | null;
  /** Most reps in one set without added weight. */
  reps: number | null;
  /** Longest hold. */
  durationS: number | null;
};

export const emptyBests = (): Bests => ({ weight: null, e1rm: null, reps: null, durationS: null });

const max = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));

export function bestsOf(sets: ExerciseSet[]): Bests {
  const b = emptyBests();
  for (const s of sets) {
    if (s.weight && s.weight > 0 && s.reps && s.reps > 0) {
      b.weight = max(b.weight, s.weight);
      b.e1rm = max(b.e1rm, e1rm(s.weight, s.reps));
    } else if (s.reps && s.reps > 0) {
      b.reps = max(b.reps, s.reps);
    }
    if (s.durationS && s.durationS > 0) b.durationS = max(b.durationS, s.durationS);
  }
  return b;
}

export function mergeBests(a: Bests, b: Bests): Bests {
  return { weight: max(a.weight, b.weight), e1rm: max(a.e1rm, b.e1rm), reps: max(a.reps, b.reps), durationS: max(a.durationS, b.durationS) };
}

export type RecordKind = keyof Bests;
export type NewRecord = { kind: RecordKind; value: number; previous: number };

/**
 * What beats the previous bests. The first time you do an exercise sets the
 * baseline and isn't a record: there's nothing to beat yet.
 */
export function newRecords(sets: ExerciseSet[], prior: Bests): NewRecord[] {
  const now = bestsOf(sets);
  const out: NewRecord[] = [];
  for (const kind of ['weight', 'e1rm', 'reps', 'durationS'] as const) {
    const v = now[kind];
    const p = prior[kind];
    if (v != null && p != null && v > p) out.push({ kind, value: v, previous: p });
  }
  // A heavier lift already says it; a higher estimate from the same lift is noise.
  return out.some((r) => r.kind === 'weight') ? out.filter((r) => r.kind !== 'e1rm') : out;
}

export type SessionMetrics = { sessionId: string; startedAt: string; topWeight: number | null; e1rm: number | null; maxReps: number | null; totalReps: number; maxDurationS: number | null; volumeKg: number };

/** One point per session for charts. */
export function sessionMetrics(e: ExerciseHistoryEntry): SessionMetrics {
  const b = bestsOf(e.sets);
  return {
    sessionId: e.sessionId,
    startedAt: e.startedAt,
    topWeight: b.weight,
    e1rm: b.e1rm,
    maxReps: max(b.reps, e.sets.reduce<number | null>((m, s) => max(m, s.reps), null)),
    totalReps: e.sets.reduce((t, s) => t + (s.reps ?? 0), 0),
    maxDurationS: b.durationS,
    volumeKg: Math.round(e.sets.reduce((t, s) => t + (s.reps ?? 0) * (s.weight ?? 0), 0) * 10) / 10,
  };
}

/** Every time a best went up, oldest first. */
export function recordTimeline(entries: ExerciseHistoryEntry[]): (NewRecord & { sessionId: string; startedAt: string })[] {
  const sorted = [...entries].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  let prior: Bests | null = null;
  const out: (NewRecord & { sessionId: string; startedAt: string })[] = [];
  for (const e of sorted) {
    if (prior) for (const r of newRecords(e.sets, prior)) out.push({ ...r, sessionId: e.sessionId, startedAt: e.startedAt });
    prior = prior ? mergeBests(prior, bestsOf(e.sets)) : bestsOf(e.sets);
  }
  return out;
}

export type ExerciseStat = { exerciseId: string; name: string; sessions: number; lastDoneAt: string; bests: Bests };
