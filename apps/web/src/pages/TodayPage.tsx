import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { type PlayerState, type PublicUser, stepsOf } from '@setryx/shared';
import { TopBar } from '../components/Shell.tsx';
import { formatMinutes, useWorkouts } from '../data.ts';
import { SESSION_EVENT, loadActive } from '../player/storage.ts';

const HTTPS_NOTICE_KEY = 'setryx.httpsNoticeDismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(HTTPS_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Shown once when the app is served over plain HTTP from a non-localhost address. */
function HttpsNotice() {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (window.isSecureContext || dismissed) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(HTTPS_NOTICE_KEY, '1');
    } catch {
      /* private mode: the notice just comes back next time */
    }
    setDismissed(true);
  };
  return (
    <div className="notice" role="note">
      <p>
        <strong>You’re on plain HTTP</strong>
        Workouts work fine. Putting setryx behind an HTTPS reverse proxy also lets you open the app with no connection, and uses the browser’s
        own keep-screen-on feature.
      </p>
      <button className="btn" type="button" onClick={dismiss}>Got it</button>
    </div>
  );
}

function useActiveSession(userId: string): PlayerState | null {
  const [active, setActive] = useState(() => loadActive(userId));
  useEffect(() => {
    const refresh = () => setActive(loadActive(userId));
    window.addEventListener(SESSION_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(SESSION_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [userId]);
  return active;
}

function ResumeBanner({ session }: { session: PlayerState }) {
  const total = stepsOf(session).length;
  const when = new Date(session.startedAt ?? session.createdAt);
  const sameDay = when.toDateString() === new Date().toDateString();
  return (
    <div className="resume-banner">
      <p>
        <strong>{session.workoutName} is still open</strong>
        On step {session.index + 1} of {total}, started {sameDay ? `at ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : when.toLocaleDateString(undefined, { weekday: 'long' })}
      </p>
      <Link className="btn" to="/play">Resume</Link>
    </div>
  );
}

export function TodayPage({ user }: { user: PublicUser }) {
  const first = user.displayName.split(' ')[0];
  const active = useActiveSession(user.id);
  const workouts = useWorkouts();
  const list = workouts.data ?? [];
  return (
    <>
      <TopBar title="Today" user={user} />
      <HttpsNotice />
      {active && <ResumeBanner session={active} />}
      {workouts.isSuccess && list.length === 0 ? (
        <section className="empty">
          <h2 className="h2">Welcome, {first}</h2>
          <p className="muted">Build your first workout, or import the routines you already have.</p>
          <div className="sheet-actions" style={{ marginTop: 14 }}>
            <Link className="btn btn-primary" to="/workouts/new">New workout</Link>
            <Link className="btn btn-quiet" to="/workouts/import">Import routines</Link>
          </div>
        </section>
      ) : (
        list.length > 0 && (
          <section className="section">
            <h2 className="h3">Start a workout</h2>
            <ul className="rows">
              {list.map((w) => (
                <li key={w.id} className="row-with-action">
                  <Link className="row row-link" to={`/play/${w.id}`}>
                    <span className="emoji" aria-hidden>{w.icon || '•'}</span>
                    <span className="main">
                      <span className="name">{w.name}</span>
                      <span className="meta">About {formatMinutes(w.estimatedS)}</span>
                    </span>
                  </Link>
                  <Link className="btn btn-primary btn-sm row-action" to={`/play/${w.id}`} aria-label={`Start ${w.name}`}>Start</Link>
                </li>
              ))}
            </ul>
            <p className="small muted" style={{ marginTop: 12 }}>Routines that suggest what’s next come in a later update.</p>
          </section>
        )
      )}
    </>
  );
}

export function ComingSoonPage({ title, user, text }: { title: string; user: PublicUser; text: string }) {
  return (
    <>
      <TopBar title={title} user={user} />
      <section className="empty">
        <h2 className="h2">Nothing here yet</h2>
        <p className="muted">{text}</p>
      </section>
    </>
  );
}
