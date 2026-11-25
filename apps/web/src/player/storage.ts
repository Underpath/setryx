import type { PlayerState } from '@setryx/shared';

// The running session is saved on this device after every change, so a reload,
// a crash or a dropped connection never loses a workout. localStorage works over
// plain HTTP too, and writes are synchronous, so nothing is lost mid-write.

const activeKey = (userId: string) => `setryx.session.active.${userId}`;
const finishedKey = (userId: string) => `setryx.session.finished.${userId}`;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadActive(userId: string): PlayerState | null {
  const s = read<PlayerState>(activeKey(userId));
  return s && s.version === 1 && s.userId === userId ? s : null;
}

const discardedKey = 'setryx.session.discarded';

export function saveActive(state: PlayerState): boolean {
  // A discarded session must never come back, even if a screen that is
  // closing saves one last time.
  if ((read<string[]>(discardedKey) ?? []).includes(state.id)) return false;
  return write(activeKey(state.userId), state);
}

export function clearActive(userId: string): void {
  write(activeKey(userId), null);
}

/** Throws the running session away for good. */
export function discardActive(userId: string, sessionId?: string): void {
  const ids = [sessionId, loadActive(userId)?.id].filter((x): x is string => !!x);
  if (ids.length) write(discardedKey, [...(read<string[]>(discardedKey) ?? []), ...ids].slice(-20));
  clearActive(userId);
}

/** Finished sessions waiting to be reviewed and sent to the server (M5). */
export function loadFinished(userId: string): PlayerState[] {
  return read<PlayerState[]>(finishedKey(userId)) ?? [];
}

export function addFinished(state: PlayerState): void {
  const list = loadFinished(state.userId).filter((s) => s.id !== state.id);
  write(finishedKey(state.userId), [...list, state]);
}

/** Lets other tabs and the Today page notice a change. */
export const SESSION_EVENT = 'setryx:session';
export function announce(): void {
  window.dispatchEvent(new Event(SESSION_EVENT));
}

export function getFinished(userId: string, id: string): PlayerState | null {
  return loadFinished(userId).find((s) => s.id === id) ?? null;
}

export function updateFinished(state: PlayerState): void {
  const list = loadFinished(state.userId);
  write(finishedKey(state.userId), list.map((s) => (s.id === state.id ? state : s)));
  announce();
}

export function removeFinished(userId: string, id: string): void {
  write(finishedKey(userId), loadFinished(userId).filter((s) => s.id !== id));
  announce();
}
