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

export function saveActive(state: PlayerState): boolean {
  return write(activeKey(state.userId), state);
}

export function clearActive(userId: string): void {
  write(activeKey(userId), null);
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
