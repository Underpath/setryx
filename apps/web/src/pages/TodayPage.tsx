import { useState } from 'react';
import type { PublicUser } from '@setryx/shared';
import { TopBar } from '../components/Shell.tsx';

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

export function TodayPage({ user }: { user: PublicUser }) {
  const first = user.displayName.split(' ')[0];
  return (
    <>
      <TopBar title="Today" user={user} />
      <HttpsNotice />
      <section className="empty">
        <h2 className="h2">Welcome, {first}</h2>
        <p className="muted">
          Your account is ready. Building workouts, importing your routines and running workouts arrive in the next updates. Until then
          you can set up your preferences in Settings{user.role === 'admin' ? ', and add the people who’ll train here' : ''}.
        </p>
      </section>
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
