import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { type Bests, type ExerciseStat, type PublicUser, type SessionSummary, WEEKDAYS, calendarWeeks, dailyStreak, weekOrder, weeklyStats } from '@setryx/shared';
import { useSetSetting } from './SettingsPage.tsx';
import { type Column, ColumnChart, Heatmap } from '../components/charts.tsx';
import { TopBar } from '../components/Shell.tsx';
import { FormError, Sheet, useToast } from '../components/ui.tsx';
import { useDeleteSession, useExerciseStats, useSession, useSessions, useStatSessions } from '../data.ts';
import { duration } from '../util.ts';

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const weekFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const minutes = (ms: number) => Math.round(ms / 60_000);
const hm = (ms: number) => {
  const m = minutes(ms);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

/** Exercise rows: name, bests, how often, when last. */
export function ExerciseRows({ list }: { list: ExerciseStat[] }) {
  return (
    <ul className="rows">
      {list.map((e) => (
        <li key={e.exerciseId}>
          <Link className="row row-link" to={`/stats/exercises/${encodeURIComponent(e.exerciseId)}`}>
            <span className="main">
              <span className="name">{e.name}</span>
              <span className="meta">{[bestsLine(e.bests), `${e.sessions} ${plural(e.sessions, 'session')}`].filter(Boolean).join(', ')}</span>
            </span>
            <span className="meta when">{dayFmt.format(new Date(e.lastDoneAt))}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A short line of an exercise's bests, for lists. */
export function bestsLine(b: Bests): string {
  const parts: string[] = [];
  if (b.weight != null) parts.push(`heaviest ${b.weight} kg`);
  if (b.e1rm != null) parts.push(`est. 1RM ${b.e1rm} kg`);
  if (b.reps != null) parts.push(`${b.reps} reps`);
  if (b.durationS != null) parts.push(`${b.durationS} s hold`);
  return parts.join(', ');
}

/** /stats/exercises: every exercise you've logged. */
export function AllExercisesPage({ user }: { user: PublicUser }) {
  const exercises = useExerciseStats();
  const [q, setQ] = useState('');
  const list = (exercises.data ?? []).filter((e) => e.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <TopBar title="All exercises" user={user} back="/stats" />
      <FormError error={exercises.error} />
      <div className="field" style={{ marginBottom: 8 }}>
        <input className="input" type="search" aria-label="Search exercises" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {exercises.isSuccess && (
        <p className="small muted" style={{ marginBottom: 6 }}>
          {list.length} of {exercises.data.length} exercises, most recent first
        </p>
      )}
      <ExerciseRows list={list} />
    </>
  );
}

export function StatsPage({ user }: { user: PublicUser }) {
  const sessions = useSessions(50);
  const points = useStatSessions(400);
  const exercises = useExerciseStats();
  const [open, setOpen] = useState<string | null>(null);
  const [measure, setMeasure] = useState<'sessions' | 'time'>('sessions');
  const [table, setTable] = useState(false);
  const weekStart = user.settings.weekStart;
  const unit = user.settings.streakUnit;
  const setSetting = useSetSetting(user);
  const list = sessions.data ?? [];

  const now = new Date();
  const weekly = useMemo(() => weeklyStats(points.data ?? [], now, weekStart, 12), [points.data, weekStart]); // eslint-disable-line react-hooks/exhaustive-deps
  const calendar = useMemo(() => calendarWeeks(points.data ?? [], now, weekStart, 26), [points.data, weekStart]); // eslint-disable-line react-hooks/exhaustive-deps
  const daily = useMemo(() => dailyStreak(points.data ?? [], now), [points.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const streak = unit === 'days' ? { current: daily.current, best: daily.best, counted: daily.today } : { current: weekly.current, best: weekly.best, counted: weekly.thisWeek.sessions > 0 };
  const dayLabels = weekOrder(weekStart).map((d) => WEEKDAYS[d]!.slice(0, 1));

  const columns: Column[] = weekly.weeks.map((w, i) => {
    const start = new Date(`${w.start}T00:00:00`);
    return {
      key: w.start,
      label: weekFmt.format(start),
      value: measure === 'sessions' ? w.sessions : minutes(w.durationMs),
      current: i === weekly.weeks.length - 1,
      tip: (
        <>
          <b>Week of {weekFmt.format(start)}</b>
          {w.sessions} session{w.sessions === 1 ? '' : 's'}, {hm(w.durationMs)}
        </>
      ),
    };
  });

  const empty = sessions.isSuccess && list.length === 0;
  return (
    <>
      <TopBar title="Stats" user={user} />
      <FormError error={sessions.error ?? points.error} />
      {empty ? (
        <section className="empty">
          <h2 className="h2">No sessions yet</h2>
          <p className="muted">Finish a workout and it shows up here: your weekly streak, a calendar of sessions, and how each exercise is going.</p>
        </section>
      ) : (
        <>
          <section className="panel" aria-labelledby="streak-h">
            <div className="panel-head">
              <h2 className="h3" id="streak-h">Streak</h2>
              <div className="seg seg-sm" role="radiogroup" aria-label="Count the streak in">
                {(['days', 'weeks'] as const).map((u) => (
                  <button key={u} type="button" role="radio" aria-checked={unit === u} className={unit === u ? 'on' : ''} onClick={() => setSetting('streakUnit', u)}>
                    {u === 'days' ? 'Days' : 'Weeks'}
                  </button>
                ))}
              </div>
            </div>
            <div className="stat-tiles">
              <div className="stat-tile streak">
                <span className="label">Current</span>
                <span className="value">{streak.current}<small>{plural(streak.current, unit === 'days' ? 'day' : 'week')}</small></span>
                <span className="sub">{streak.counted ? `${unit === 'days' ? 'Today' : 'This week'} counts` : streak.current ? `Train ${unit === 'days' ? 'today' : 'this week'} to keep it` : `Train ${unit === 'days' ? 'today' : 'this week'} to start one`}</span>
              </div>
              <div className="stat-tile">
                <span className="label">Best</span>
                <span className="value">{streak.best}<small>{plural(streak.best, unit === 'days' ? 'day' : 'week')}</small></span>
              </div>
              <div className="stat-tile">
                <span className="label">This week</span>
                <span className="value">{weekly.thisWeek.sessions}<small>{plural(weekly.thisWeek.sessions, 'session')}</small></span>
                <span className="sub">{hm(weekly.thisWeek.durationMs)}</span>
              </div>
            </div>
          </section>

          <section className="panel" aria-labelledby="cal-h">
            <div className="panel-head"><h2 className="h3" id="cal-h">Calendar</h2><span className="panel-meta">Last six months</span></div>
            <Heatmap
              weeks={calendar}
              dayLabels={dayLabels}
              describe={(d) =>
                `${d.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${d.sessions ? `${d.sessions} session${d.sessions === 1 ? '' : 's'}, ${hm(d.durationMs)}` : 'no sessions'}`
              }
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="h3">{measure === 'sessions' ? 'Sessions per week' : 'Minutes per week'}</h2>
              <div className="seg seg-sm" role="radiogroup" aria-label="Measure">
                <button type="button" role="radio" aria-checked={measure === 'sessions'} className={measure === 'sessions' ? 'on' : ''} onClick={() => setMeasure('sessions')}>Sessions</button>
                <button type="button" role="radio" aria-checked={measure === 'time'} className={measure === 'time' ? 'on' : ''} onClick={() => setMeasure('time')}>Time</button>
              </div>
            </div>
            {table ? (
              <table className="data-table">
                <thead><tr><th>Week of</th><th>Sessions</th><th>Time</th></tr></thead>
                <tbody>
                  {[...weekly.weeks].reverse().map((w) => (
                    <tr key={w.start}><td>{weekFmt.format(new Date(`${w.start}T00:00:00`))}</td><td>{w.sessions}</td><td>{hm(w.durationMs)}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <ColumnChart data={columns} unit={measure === 'sessions' ? 'sessions' : 'minutes'} title={`${measure === 'sessions' ? 'Sessions' : 'Minutes'} per week, last 12 weeks`} />
            )}
            <button className="link-btn small" type="button" onClick={() => setTable(!table)}>{table ? 'Show as chart' : 'Show as table'}</button>
          </section>

          {(exercises.data?.length ?? 0) > 0 && (
            <section className="panel" aria-labelledby="ex-h">
              <div className="panel-head">
                <h2 className="h3" id="ex-h">Exercises</h2>
                <span className="panel-meta">Most recent first</span>
              </div>
              <ExerciseRows list={exercises.data!.slice(0, 5)} />
              {exercises.data!.length > 5 && (
                <Link className="btn btn-quiet btn-sm panel-more" to="/stats/exercises">All {exercises.data!.length} exercises</Link>
              )}
            </section>
          )}

          <section className="panel" aria-labelledby="recent-h">
            <div className="panel-head"><h2 className="h3" id="recent-h">Recent sessions</h2></div>
            <ul className="rows">
              {list.map((s) => (
                <li key={s.id}>
                  <button className="row row-button" type="button" onClick={() => setOpen(s.id)}>
                    <span className="emoji" aria-hidden>{s.icon || '•'}</span>
                    <span className="main">
                      <span className="name">{s.workoutName}</span>
                      <span className="meta">{describe(s)}</span>
                    </span>
                    <span className="meta when">{dayFmt.format(new Date(s.startedAt))}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      {open && <SessionSheet id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function describe(s: SessionSummary): string {
  const parts = [duration(s.durationMs), `${s.setCount} set${s.setCount === 1 ? '' : 's'}`];
  if (s.volumeKg) parts.push(`${Math.round(s.volumeKg).toLocaleString()} kg`);
  if (s.status === 'ended_early') parts.push('ended early');
  return parts.join(', ');
}

function SessionSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useSession(id);
  const del = useDeleteSession();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const s = q.data;
  const groups = new Map<string, NonNullable<typeof s>['logs']>();
  for (const l of s?.logs ?? []) groups.set(l.itemId, [...(groups.get(l.itemId) ?? []), l]);
  return (
    <Sheet title={s ? s.workoutName : 'Session'} onClose={onClose}>
      <FormError error={q.error} />
      {s && (
        <>
          <p className="muted">
            {dayFmt.format(new Date(s.startedAt))} at {timeFmt.format(new Date(s.startedAt))}. {describe(s)}.
          </p>
          <ul className="rows">
            {[...groups.values()].map((logs) => (
              <li className="row" key={logs[0]!.itemId}>
                <div className="main">
                  <div className="name">{s.exercises[logs[0]!.exerciseId]?.name ?? 'Exercise'}</div>
                  <div className="meta">
                    {logs
                      .map((l) => `${l.actualReps ?? `${l.actualDurationS} s`}${l.actualWeight != null ? ` × ${l.actualWeight} kg` : ''}`)
                      .join(', ')}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {!confirm ? (
            <button className="btn btn-danger btn-sm" type="button" style={{ justifySelf: 'start' }} onClick={() => setConfirm(true)}>Delete session</button>
          ) : (
            <div className="sheet-actions">
              <span className="small muted" style={{ alignSelf: 'center' }}>Delete this session for good?</span>
              <button
                className="btn btn-primary btn-sm"
                type="button"
                onClick={() => del.mutate(id, { onSuccess: () => (toast('Session deleted'), onClose()) })}
              >
                Delete
              </button>
              <button className="btn btn-sm" type="button" onClick={() => setConfirm(false)}>Keep</button>
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
