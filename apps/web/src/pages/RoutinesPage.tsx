import { Link } from 'react-router';
import type { PublicUser } from '@setryx/shared';
import { TopBar } from '../components/Shell.tsx';
import { FormError } from '../components/ui.tsx';
import { MODE_LABEL, RoutineStrip, type RoutineWithStatus, useRoutineStatuses } from '../components/routines.tsx';

function describe(s: RoutineWithStatus): string {
  const n = s.routine.entries.length;
  const parts = [MODE_LABEL[s.routine.mode], `${n} workout${n === 1 ? '' : 's'}`];
  if (!s.routine.active) parts.push('paused');
  else if (s.status.kind === 'next') parts.push(`next: ${s.status.entry.workoutName}`);
  else if (s.status.kind === 'complete') parts.push('complete');
  return parts.join(', ');
}

export function RoutinesPage({ user }: { user: PublicUser }) {
  const { query, list } = useRoutineStatuses(user.id, user.settings.weekStart);
  return (
    <>
      <TopBar title="Routines" user={user} actions={<Link className="btn btn-primary btn-sm" to="/routines/new">New routine</Link>} />
      <FormError error={query.error} />
      {query.isSuccess && list.length === 0 && (
        <section className="empty">
          <h2 className="h2">No routines yet</h2>
          <p className="muted">
            Group workouts into a routine: a rotation like Push A, Pull A, Push B, Pull B, a programme you go through once, or a workout for each day of the
            week. Today then shows which one is next.
          </p>
          <div className="sheet-actions" style={{ marginTop: 14 }}>
            <Link className="btn btn-primary" to="/routines/new">New routine</Link>
          </div>
        </section>
      )}
      {list.length > 0 && (
        <ul className="routine-list">
          {list.map((s) => (
            <li key={s.routine.id}>
              <Link className={`routine-card${s.routine.active ? '' : ' paused'}`} to={`/routines/${s.routine.id}`}>
                <span className="name">{s.routine.name}</span>
                <span className="meta">{describe(s)}</span>
                {s.routine.active && <RoutineStrip {...s} />}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
