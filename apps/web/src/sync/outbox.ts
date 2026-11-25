import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router';
import { type PlayerState, type SessionUpload, type TargetUpdates, sessionUploadOf } from '@setryx/shared';
import { api, ApiRequestError } from '../api.ts';
import { loadFinished, removeFinished } from '../player/storage.ts';

// Things the device has to tell the server, kept on the device until the
// server confirms them. Uploads are idempotent (sessions have a fixed id), so
// sending one twice after a dropped connection is harmless.

export type OutboxItem =
  | { id: string; kind: 'session'; sessionId: string; label: string; body: SessionUpload; error?: string; attempts: number }
  | { id: string; kind: 'targets'; workoutId: string; label: string; body: TargetUpdates; error?: string; attempts: number };

export type NewOutboxItem = Omit<Extract<OutboxItem, { kind: 'session' }>, 'attempts' | 'error'> | Omit<Extract<OutboxItem, { kind: 'targets' }>, 'attempts' | 'error'>;

const key = (userId: string) => `setryx.outbox.${userId}`;
export const OUTBOX_EVENT = 'setryx:outbox';

export function readOutbox(userId: string): OutboxItem[] {
  try {
    return JSON.parse(localStorage.getItem(key(userId)) ?? '[]') as OutboxItem[];
  } catch {
    return [];
  }
}

function writeOutbox(userId: string, items: OutboxItem[]): void {
  try {
    if (items.length) localStorage.setItem(key(userId), JSON.stringify(items));
    else localStorage.removeItem(key(userId));
  } catch {
    /* storage full or blocked: nothing we can do here */
  }
  window.dispatchEvent(new Event(OUTBOX_EVENT));
}

export function enqueue(userId: string, item: NewOutboxItem): void {
  const items = readOutbox(userId).filter((i) => i.id !== item.id);
  writeOutbox(userId, [...items, { ...item, attempts: 0 } as OutboxItem]);
}

/** Queues a finished session (and any target updates) for the server and takes it off the review list. */
export function saveFinished(state: PlayerState, targets?: TargetUpdates): void {
  enqueue(state.userId, { id: `session:${state.id}`, kind: 'session', sessionId: state.id, label: state.workoutName, body: sessionUploadOf(state) });
  if (targets?.updates.length && state.workoutId) {
    enqueue(state.userId, { id: `targets:${state.id}`, kind: 'targets', workoutId: state.workoutId, label: state.workoutName, body: targets });
  }
  removeFinished(state.userId, state.id);
}

export function dropFromOutbox(userId: string, id: string): void {
  writeOutbox(userId, readOutbox(userId).filter((i) => i.id !== id));
}

/** A failure that retrying won't fix (the server rejected the data). */
const isPermanent = (e: unknown) => e instanceof ApiRequestError && e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);

let flushing: Promise<FlushResult> | null = null;
export type FlushResult = { sent: OutboxItem[]; offline: boolean };

/** Sends everything waiting, oldest first. Stops at the first network failure. */
export function flushOutbox(userId: string): Promise<FlushResult> {
  flushing ??= (async () => {
    const sent: OutboxItem[] = [];
    let offline = false;
    for (const item of readOutbox(userId)) {
      if (item.error && item.attempts >= 3) continue; // rejected by the server; shown to the user
      try {
        if (item.kind === 'session') await api.put(`/sessions/${item.sessionId}`, item.body);
        else await api.post(`/workouts/${item.workoutId}/targets`, item.body);
        dropFromOutbox(userId, item.id);
        sent.push(item);
      } catch (e) {
        const list = readOutbox(userId);
        const permanent = isPermanent(e);
        writeOutbox(
          userId,
          list.map((i) => (i.id === item.id ? { ...i, attempts: permanent ? 3 : i.attempts + 1, error: permanent ? (e as Error).message : undefined } : i)),
        );
        if (!permanent) {
          offline = true;
          break;
        }
      }
    }
    return { sent, offline };
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** The current outbox, kept up to date. */
export function useOutbox(userId: string): OutboxItem[] {
  const [items, setItems] = useState(() => readOutbox(userId));
  useEffect(() => {
    const refresh = () => setItems(readOutbox(userId));
    window.addEventListener(OUTBOX_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(OUTBOX_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [userId]);
  return items;
}

/**
 * Background sender: tries on start, when the browser comes back online,
 * when the app becomes visible, and every 20 s while something is waiting.
 */
export function SyncRunner({ userId }: { userId: string }) {
  const items = useOutbox(userId);
  const { pathname } = useLocation();

  // Leaving the review screen counts as done: any finished session that isn't
  // on screen right now is saved as it is (target updates need a tick, so none).
  // Runs on navigation only: a workout that just finished is still on the
  // player route until it moves on to its review.
  useEffect(() => {
    if (pathname.startsWith('/play')) return;
    const reviewing = pathname.match(/^\/review\/([^/]+)/)?.[1];
    const left = loadFinished(userId).filter((s) => s.id !== reviewing);
    for (const s of left) saveFinished(s);
    if (left.length) void flushOutbox(userId);
  }, [userId, pathname]);

  const qc = useQueryClient();
  const pending = items.some((i) => !(i.error && i.attempts >= 3));

  useEffect(() => {
    const run = async () => {
      const r = await flushOutbox(userId);
      if (r.sent.length) {
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        for (const s of r.sent) {
          if (s.kind === 'targets') {
            void qc.invalidateQueries({ queryKey: ['workout', s.workoutId] });
            void qc.invalidateQueries({ queryKey: ['workouts'] });
          }
        }
      }
    };
    void run();
    if (!pending) return;
    const id = window.setInterval(run, 20_000);
    const onVisible = () => document.visibilityState === 'visible' && void run();
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId, pending, qc]);

  return null;
}
