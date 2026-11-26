import { Link } from 'react-router';
import type { PublicUser } from '@setryx/shared';
import { TopBar } from '../components/Shell.tsx';
import { FormError } from '../components/ui.tsx';
import { formatMinutes, useWorkouts } from '../data.ts';

export function WorkoutsPage({ user }: { user: PublicUser }) {
  const workouts = useWorkouts();
  const list = workouts.data ?? [];
  return (
    <>
      <TopBar title="Workouts" user={user} actions={<Link className="btn btn-primary btn-sm" to="/workouts/new">New workout</Link>} />
      <FormError error={workouts.error} />
      {workouts.isSuccess && list.length === 0 && (
        <section className="empty">
          <h2 className="h2">No workouts yet</h2>
          <p className="muted">Build one from the exercise library, or bring in the routines you already have from a JSON export.</p>
          <div className="sheet-actions" style={{ marginTop: 14 }}>
            <Link className="btn btn-primary" to="/workouts/new">New workout</Link>
            <Link className="btn btn-quiet" to="/workouts/import">Import routines</Link>
          </div>
        </section>
      )}
      {list.length > 0 && (
        <ul className="rows" style={{ marginTop: 8 }}>
          {list.map((w) => (
            <li key={w.id} className="row-with-action">
              <Link className="row row-link" to={`/workouts/${w.id}`}>
                <span className="emoji" aria-hidden>{w.icon || '•'}</span>
                <span className="main">
                  <span className="name">{w.name}</span>
                  <span className="meta">
                    {w.supersetCount ? `${w.supersetCount} superset${w.supersetCount === 1 ? '' : 's'}` : `${w.blockCount} step${w.blockCount === 1 ? '' : 's'}`}, about {formatMinutes(w.estimatedS)}
                  </span>
                </span>
              </Link>
              <Link className="btn btn-quiet btn-sm row-action" to={`/play/${w.id}`} aria-label={`Start ${w.name}`}>Start</Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
