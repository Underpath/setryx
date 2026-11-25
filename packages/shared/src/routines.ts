import { z } from 'zod';

// A routine is a group of workouts with a schedule:
//   repeat  cycle through in order; next is the one after the last done
//   once    go through in order, then the routine is complete
//   weekly  workouts on set weekdays; shows today's and any missed this week
// Weekdays are 0 = Monday … 6 = Sunday.

export const routineModeSchema = z.enum(['repeat', 'once', 'weekly']);
export type RoutineMode = z.infer<typeof routineModeSchema>;

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export const routineEntryInputSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid entry id.'),
  workoutId: z.string().min(1).max(64),
  weekday: z.number().int().min(0).max(6).nullable().default(null),
});

export const routineInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the routine a name.').max(80, 'Use at most 80 characters.'),
    mode: routineModeSchema,
    active: z.boolean().default(true),
    entries: z.array(routineEntryInputSchema).min(1, 'Add at least one workout.').max(50, 'Use at most 50 workouts.'),
  })
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    r.entries.forEach((e, i) => {
      if (seen.has(e.id)) ctx.addIssue({ code: 'custom', path: ['entries', i], message: 'Duplicate entry id.' });
      seen.add(e.id);
      if (r.mode === 'weekly' && e.weekday == null) ctx.addIssue({ code: 'custom', path: ['entries', i], message: 'Pick a day for every workout.' });
    });
  });
export type RoutineInput = z.input<typeof routineInputSchema>;

export const routineActiveSchema = z.object({ active: z.boolean() });

export type RoutineEntry = {
  id: string;
  workoutId: string;
  weekday: number | null;
  /** Null when the workout was deleted. */
  workoutName: string | null;
  icon: string;
};

/** A session done as part of a routine. */
export type RoutineRun = { entryId: string; startedAt: string };

export type Routine = {
  id: string;
  name: string;
  mode: RoutineMode;
  active: boolean;
  /** Progress counts from here; restarting moves it to now. */
  startedAt: string;
  entries: RoutineEntry[];
  /** Recent sessions done as part of this routine since startedAt, newest first. */
  runs: RoutineRun[];
  createdAt: string;
  updatedAt: string;
};

export type RoutineStatus =
  | { kind: 'next'; entry: RoutineEntry; position: number; total: number; lastDoneAt: string | null }
  | { kind: 'complete'; finishedAt: string }
  | {
      kind: 'week';
      /** Today's workouts, each with when it was done (null if not yet). */
      today: { entry: RoutineEntry; doneAt: string | null }[];
      /** Earlier this week and not done yet. */
      missed: RoutineEntry[];
      /** When nothing is on today: the next day with workouts. */
      upcoming: { weekday: number; entries: RoutineEntry[] } | null;
    }
  | { kind: 'empty' };

/** Monday = 0 … Sunday = 6, in local time. */
export const weekdayOf = (d: Date) => (d.getDay() + 6) % 7;

export function startOfWeek(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - weekdayOf(d));
  return d;
}

/** What's due in a routine right now. Entries whose workout was deleted are skipped. */
export function routineStatus(r: Pick<Routine, 'mode' | 'entries' | 'startedAt'>, runs: RoutineRun[], now: Date): RoutineStatus {
  const entries = r.entries.filter((e) => e.workoutName != null);
  if (!entries.length) return { kind: 'empty' };
  const since = Date.parse(r.startedAt);
  const ids = new Set(entries.map((e) => e.id));
  const valid = runs.filter((x) => ids.has(x.entryId) && Date.parse(x.startedAt) >= since).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  if (r.mode === 'weekly') {
    const weekStart = startOfWeek(now).getTime();
    const todayIdx = weekdayOf(now);
    const doneThisWeek = (e: RoutineEntry) => valid.find((x) => x.entryId === e.id && Date.parse(x.startedAt) >= weekStart)?.startedAt ?? null;
    const today = entries.filter((e) => e.weekday === todayIdx).map((entry) => ({ entry, doneAt: doneThisWeek(entry) }));
    const missed = entries.filter((e) => e.weekday != null && e.weekday < todayIdx && !doneThisWeek(e));
    let upcoming: { weekday: number; entries: RoutineEntry[] } | null = null;
    if (!today.length) {
      for (let k = 1; k <= 7 && !upcoming; k++) {
        const day = (todayIdx + k) % 7;
        const list = entries.filter((e) => e.weekday === day);
        if (list.length) upcoming = { weekday: day, entries: list };
      }
    }
    return { kind: 'week', today, missed, upcoming };
  }

  const last = valid[0];
  const lastPos = last ? entries.findIndex((e) => e.id === last.entryId) : -1;
  if (r.mode === 'once' && last && lastPos === entries.length - 1) return { kind: 'complete', finishedAt: last.startedAt };
  const pos = (lastPos + 1) % entries.length;
  return { kind: 'next', entry: entries[pos]!, position: pos + 1, total: entries.length, lastDoneAt: last?.startedAt ?? null };
}

/** The entries a routine is waiting on right now (what "Up next" offers). */
export function dueEntries(status: RoutineStatus): RoutineEntry[] {
  if (status.kind === 'next') return [status.entry];
  if (status.kind === 'week') return [...status.today.filter((t) => !t.doneAt).map((t) => t.entry), ...status.missed];
  return [];
}

/**
 * When a workout is started without picking a routine, it still counts for the
 * first active routine that is waiting on that workout.
 */
export function routineContextFor(
  workoutId: string,
  routines: Routine[],
  now: Date,
  extraRuns: (RoutineRun & { routineId: string })[] = [],
): { routineId: string; entryId: string } | null {
  for (const r of routines) {
    if (!r.active) continue;
    const runs = [...r.runs, ...extraRuns.filter((x) => x.routineId === r.id)];
    const hit = dueEntries(routineStatus(r, runs, now)).find((e) => e.workoutId === workoutId);
    if (hit) return { routineId: r.id, entryId: hit.id };
  }
  return null;
}
