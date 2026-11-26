import { useState } from 'react';
import type { PublicUser } from '@setryx/shared';
import { useLogout } from '../session.ts';
import { flushOutbox, readOutbox, unsyncedOnDevice } from '../sync/outbox.ts';
import { Sheet } from './ui.tsx';

/**
 * Signing out deletes what this account keeps on the device. Anything the
 * server doesn't have yet is sent first; whatever can't be sent is listed, and
 * signing out waits for a yes.
 */
export function useSignOut(user: PublicUser) {
  const logout = useLogout(user.id);
  const [checking, setChecking] = useState(false);
  const [unsynced, setUnsynced] = useState<string[] | null>(null);

  const start = async () => {
    setChecking(true);
    try {
      if (readOutbox(user.id).length) await flushOutbox(user.id).catch(() => undefined);
    } finally {
      setChecking(false);
    }
    const left = unsyncedOnDevice(user.id);
    if (left.length) setUnsynced(left);
    else logout.mutate();
  };

  const sheet = unsynced && (
    <Sheet title="Sign out and delete them from this device?" onClose={() => setUnsynced(null)}>
      <p className="muted">These are only on this device, so signing out deletes them:</p>
      <ul className="unsynced-list">
        {unsynced.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <p className="muted">To keep them, stay signed in. Finish or save your workouts and reconnect, and they reach the server on their own.</p>
      <button className="btn btn-block" type="button" data-autofocus onClick={() => setUnsynced(null)}>Stay signed in</button>
      <button className="btn btn-danger btn-block" type="button" disabled={logout.isPending} onClick={() => logout.mutate()}>Sign out and delete them</button>
    </Sheet>
  );

  return { start: () => void start(), pending: checking || logout.isPending, sheet };
}
