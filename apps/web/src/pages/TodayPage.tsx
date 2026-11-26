import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { type PlayerState, type PublicUser, stepsOf } from '@setryx/shared';
import { TopBar } from '../components/Shell.tsx';
import { SignInAlerts } from './AdminPage.tsx';
import { formatMinutes, useRestartRoutine, useWorkouts } from '../data.ts';
import { UpNextCard, useRoutineStatuses } from '../components/routines.tsx';
import { SESSION_EVENT, loadActive } from '../player/storage.ts';
import { dropFromOutbox, useOutbox } from '../sync/outbox.ts';

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
        Workouts work fine. Putting Setryx behind an HTTPS reverse proxy also lets you open the app with no connection, and uses the browser’s
        own keep-screen-on feature.
      </p>
      <button className="btn" type="button" onClick={dismiss}>Got it</button>
    </div>
  );
}

function useActiveSession(userId: string): PlayerState | null {
  const read = () => loadActive(userId);
  const [state, setState] = useState(read);
  useEffect(() => {
    const refresh = () => setState(read());
    window.addEventListener(SESSION_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(SESSION_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);
  return state;
}

/** Saved on this device, waiting for the server. */
function OutboxBanner({ userId }: { userId: string }) {
  const items = useOutbox(userId);
  if (!items.length) return null;
  const failed = items.filter((i) => i.error && i.attempts >= 3);
  const waiting = items.filter((i) => !(i.error && i.attempts >= 3) && i.kind === 'session').length;
  return (
    <div className="notice outbox-notice" role="status">
      <p>
        {waiting > 0 && (
          <>
            <strong>{waiting} session{waiting === 1 ? '' : 's'} waiting to upload</strong>
            Saved on this device. They upload as soon as the server is reachable.
          </>
        )}
        {failed.map((f) => (
          <span key={f.id} className="outbox-failed">
            <strong>Couldn’t save {f.kind === 'session' ? 'the session' : 'the target updates'} for {f.label}</strong>
            {f.error}{' '}
            <button className="link-btn" type="button" onClick={() => dropFromOutbox(userId, f.id)}>Remove it</button>
          </span>
        ))}
      </p>
    </div>
  );
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

/** One card per active routine: what's due now. */
function UpNext({ user }: { user: PublicUser }) {
  const { list } = useRoutineStatuses(user.id);
  const restart = useRestartRoutine();
  const active = list.filter((s) => s.routine.active && s.status.kind !== 'empty');
  if (!active.length) return null;
  return (
    <section className="section upnext-list" aria-label="Up next">
      {active.map((item) => (
        <UpNextCard
          key={item.routine.id}
          item={item}
          restarting={restart.isPending && restart.variables === item.routine.id}
          onRestart={() => restart.mutate(item.routine.id)}
        />
      ))}
    </section>
  );
}

export function TodayPage({ user }: { user: PublicUser }) {
  const first = user.displayName.split(' ')[0];
  const active = useActiveSession(user.id);
  const workouts = useWorkouts();
  const list = workouts.data ?? [];
  const routines = useRoutineStatuses(user.id);
  return (
    <>
      <TopBar title="Today" user={user} />
      <HttpsNotice />
      {user.role === 'admin' && <SignInAlerts linkToPeople />}
      {active && <ResumeBanner session={active} />}
      <OutboxBanner userId={user.id} />
      <UpNext user={user} />
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
            {routines.query.isSuccess && routines.list.length === 0 && (
            <p className="small muted" style={{ marginTop: 12 }}>
              Group workouts into a <Link to="/routines/new">routine</Link> and Today shows which one is next.
            </p>
            )}
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
