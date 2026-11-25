import { useState } from 'react';
import type { PublicUser, SessionSummary } from '@setryx/shared';
import { TopBar } from '../components/Shell.tsx';
import { FormError, Sheet, useToast } from '../components/ui.tsx';
import { useDeleteSession, useSession, useSessions } from '../data.ts';
import { duration } from '../util.ts';

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function StatsPage({ user }: { user: PublicUser }) {
  const sessions = useSessions(50);
  const [open, setOpen] = useState<string | null>(null);
  const list = sessions.data ?? [];
  return (
    <>
      <TopBar title="Stats" user={user} />
      <FormError error={sessions.error} />
      {sessions.isSuccess && list.length === 0 ? (
        <section className="empty">
          <h2 className="h2">No sessions yet</h2>
          <p className="muted">Finish a workout and save it from the review screen; it shows up here. Charts and personal records come in a later update.</p>
        </section>
      ) : (
        <section className="section">
          <h2 className="h3">Recent sessions</h2>
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
          <p className="small muted" style={{ marginTop: 12 }}>Charts, personal records and streaks come in a later update.</p>
        </section>
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
