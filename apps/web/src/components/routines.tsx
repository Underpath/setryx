import { useMemo } from 'react';
import { Link } from 'react-router';
import { type Routine, type RoutineEntry, type RoutineRun, type RoutineStatus, WEEKDAYS, routineStatus, startOfWeek, weekdayOf } from '@setryx/shared';
import { useRoutines } from '../data.ts';
import { pendingRuns, useOutbox } from '../sync/outbox.ts';

export const MODE_LABEL: Record<Routine['mode'], string> = { repeat: 'Repeats', once: 'Once through', weekly: 'Weekly' };

export type RoutineWithStatus = { routine: Routine; runs: RoutineRun[]; status: RoutineStatus };

/** Every routine with what's due, counting sessions still waiting to upload. */
export function useRoutineStatuses(userId: string) {
  const q = useRoutines();
  const outbox = useOutbox(userId);
  const list = useMemo((): RoutineWithStatus[] => {
    const extra = pendingRuns(outbox);
    const now = new Date();
    return (q.data ?? []).map((routine) => {
      const runs = [...routine.runs, ...extra.filter((x) => x.routineId === routine.id && !routine.runs.some((r) => r.entryId === x.entryId && r.startedAt === x.startedAt))];
      return { routine, runs, status: routineStatus(routine, runs, now) };
    });
  }, [q.data, outbox]);
  return { query: q, list };
}

export const playUrl = (routineId: string, e: RoutineEntry) => `/play/${e.workoutId}?routine=${routineId}&entry=${e.id}`;

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
function ago(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return dayFmt.format(d);
  return `${days} days ago`;
}
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * The routine as a strip: the rotation in order (done, next, to come), or the
 * week Monday to Sunday (done, today, missed, planned).
 */
export function RoutineStrip({ routine, runs, status }: RoutineWithStatus) {
  const entries = routine.entries.filter((e) => e.workoutName != null);
  if (routine.mode === 'weekly') {
    const weekStart = startOfWeek(new Date()).getTime();
    const today = weekdayOf(new Date());
    const doneIds = new Set(runs.filter((r) => Date.parse(r.startedAt) >= weekStart).map((r) => r.entryId));
    return (
      <ol className="week-strip" aria-label="This week">
        {WEEKDAYS.map((name, day) => {
          const list = entries.filter((e) => e.weekday === day);
          const done = list.length > 0 && list.every((e) => doneIds.has(e.id));
          const missed = day < today && list.some((e) => !doneIds.has(e.id));
          const cls = ['day', list.length ? 'planned' : '', done ? 'done' : '', missed ? 'missed' : '', day === today ? 'today' : ''].filter(Boolean).join(' ');
          const what = list.length ? `${list.map((e) => e.workoutName).join(', ')}${done ? ', done' : missed ? ', missed' : ''}` : 'rest day';
          return (
            <li key={name} className={cls} title={`${name}: ${what}`} aria-label={`${name}: ${what}`}>
              <span>{name[0]}</span>
            </li>
          );
        })}
      </ol>
    );
  }
  const nextPos = status.kind === 'next' ? status.position - 1 : status.kind === 'complete' ? entries.length : 0;
  // In a repeating routine, a fresh lap starts once the last one is done.
  const lapStarted = runs.length > 0;
  return (
    <ol className="rot-strip" aria-label="Order">
      {entries.map((e, i) => {
        const done = lapStarted && i < nextPos;
        const next = status.kind === 'next' && i === nextPos;
        return (
          <li key={e.id} className={done ? 'done' : next ? 'next' : ''} aria-current={next ? 'step' : undefined}>
            <span className="t">{e.workoutName}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Today's "Up next" for one active routine. */
export function UpNextCard({ item, onRestart, restarting }: { item: RoutineWithStatus; onRestart: () => void; restarting: boolean }) {
  const { routine, status } = item;
  const head = (
    <div className="upnext-head">
      <Link to={`/routines/${routine.id}`} className="upnext-routine">{routine.name}</Link>
      <span className="upnext-mode">{MODE_LABEL[routine.mode]}</span>
    </div>
  );

  if (status.kind === 'empty') return null;

  if (status.kind === 'complete') {
    return (
      <article className="upnext done">
        {head}
        <h2 className="upnext-title">Routine complete</h2>
        <p className="upnext-meta">You finished the last workout {ago(status.finishedAt)}.</p>
        <RoutineStrip {...item} />
        <div className="upnext-actions">
          <button className="btn btn-sm" type="button" onClick={onRestart} disabled={restarting}>Start it again</button>
        </div>
      </article>
    );
  }

  if (status.kind === 'next') {
    const e = status.entry;
    return (
      <article className="upnext">
        {head}
        <div className="upnext-main">
          <h2 className="upnext-title">
            {e.icon && <span aria-hidden>{e.icon} </span>}
            {e.workoutName}
          </h2>
          <Link className="btn btn-primary" to={playUrl(routine.id, e)}>Start</Link>
        </div>
        <p className="upnext-meta">
          Workout {status.position} of {status.total}
          {status.lastDoneAt ? `, last one ${ago(status.lastDoneAt)}` : ''}
        </p>
        <RoutineStrip {...item} />
      </article>
    );
  }

  // Weekly
  const todo = status.today.filter((t) => !t.doneAt);
  return (
    <article className="upnext">
      {head}
      {status.today.length === 0 ? (
        <>
          <h2 className="upnext-title">Rest day</h2>
          {status.upcoming && (
            <p className="upnext-meta">
              Next: {status.upcoming.entries.map((e) => e.workoutName).join(', ')} on {WEEKDAYS[status.upcoming.weekday]}.
            </p>
          )}
        </>
      ) : todo.length === 0 ? (
        <>
          <h2 className="upnext-title">Done for today</h2>
          <p className="upnext-meta">{status.today.map((t) => t.entry.workoutName).join(', ')} done.</p>
        </>
      ) : (
        todo.map(({ entry }) => (
          <div className="upnext-main" key={entry.id}>
            <h2 className="upnext-title">
              {entry.icon && <span aria-hidden>{entry.icon} </span>}
              {entry.workoutName}
            </h2>
            <Link className="btn btn-primary" to={playUrl(routine.id, entry)}>Start</Link>
          </div>
        ))
      )}
      {status.missed.length > 0 && (
        <ul className="upnext-missed">
          {status.missed.map((e) => (
            <li key={e.id}>
              <span>Missed {WEEKDAYS[e.weekday!]}: <b>{e.workoutName}</b></span>
              <Link className="btn btn-sm" to={playUrl(routine.id, e)}>Do it now</Link>
            </li>
          ))}
        </ul>
      )}
      <RoutineStrip {...item} />
    </article>
  );
}
