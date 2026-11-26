import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

// OWASP-recommended argon2id parameters: 19 MiB memory, 2 passes, 1 lane.
const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

// Each argon2 run takes a thread from Node's small pool and 19 MiB of memory,
// so only a few run at once and a flood of sign-ins waits in a short queue
// instead of starving file access for everyone else. The last places in the
// queue are kept for checks that matter most (a device that has signed in to
// that account before, or someone already signed in), and those go first.
const MAX_RUNNING = 2;
const MAX_WAITING = 50;
const KEPT_FOR_PRIORITY = 15;
let running = 0;
const waiting: (() => void)[] = [];
const waitingFirst: (() => void)[] = [];

/** Thrown when too many password checks are already waiting. */
export class PasswordsBusyError extends Error {}

export type CheckOptions = { priority?: boolean };

async function slot<T>(work: () => Promise<T>, priority = false): Promise<T> {
  if (running >= MAX_RUNNING) {
    const queued = waiting.length + waitingFirst.length;
    if (queued >= MAX_WAITING || (!priority && queued >= MAX_WAITING - KEPT_FOR_PRIORITY)) throw new PasswordsBusyError('Too many password checks at once.');
    await new Promise<void>((resolve) => (priority ? waitingFirst : waiting).push(resolve));
  } else {
    running++;
  }
  try {
    return await work();
  } finally {
    const next = waitingFirst.shift() ?? waiting.shift();
    if (next) next(); // hand the slot straight on
    else running--;
  }
}

function derive(password: string, nonce: Buffer, p: typeof PARAMS, priority = false): Promise<Buffer> {
  return slot(
    () =>
      new Promise((resolve, reject) => {
        argon2('argon2id', { message: password, nonce, ...p }, (err, key) => (err ? reject(err) : resolve(key)));
      }),
    priority,
  );
}

/** Returns a PHC-format string: $argon2id$v=19$m=…,t=…,p=…$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** How long a password check takes, waiting included: a moving average of recent ones. */
let typicalMs = 80;
const record = (ms: number) => (typicalMs = typicalMs * 0.8 + ms * 0.2);

export async function verifyPassword(password: string, stored: string, opts: CheckOptions = {}): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, 'base64url');
  const t0 = performance.now();
  const actual = await derive(
    password,
    Buffer.from(m[4]!, 'base64url'),
    { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]), tagLength: expected.length },
    opts.priority,
  );
  record(performance.now() - t0);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * For a username that doesn't exist: takes about as long as checking a real
 * password does right now, without running argon2. Made-up names then cost
 * nothing to check and can't fill the queue, and timing still doesn't reveal
 * which names exist.
 */
export async function pretendVerify(): Promise<false> {
  const ms = typicalMs * (0.85 + Math.random() * 0.3);
  await new Promise((r) => setTimeout(r, ms));
  return false;
}

/** Measures one real check at startup, so the first pretend ones take the right time. */
export async function warmUp(): Promise<void> {
  const h = await hashPassword('not-a-real-password');
  const t0 = performance.now();
  await verifyPassword('also-not-real', h);
  typicalMs = performance.now() - t0;
}
