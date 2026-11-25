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
      <section className="section">
        <h2 className="h3">Move your data</h2>
        <ul className="rows">
          <li className="row">
            <div className="main"><div className="name">Import routines</div><div className="meta">From a JSON export of your earlier tracker.</div></div>
            <Link className="btn btn-quiet btn-sm" to="/workouts/import">Import</Link>
          </li>
          <li className="row">
            <div className="main"><div className="name">Export everything</div><div className="meta">Your workouts and your own exercises, as a JSON file.</div></div>
            <a className="btn btn-quiet btn-sm" href="/api/v1/export" download>Export</a>
          </li>
        </ul>
      </section>
    </>
  );
}
