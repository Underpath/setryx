import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

// OWASP-recommended argon2id parameters: 19 MiB memory, 2 passes, 1 lane.
const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

// Each argon2 run takes a thread from Node's small pool and 19 MiB of memory,
// so only a few run at once and a flood of sign-ins waits in a short queue
// instead of starving file access for everyone else.
const MAX_RUNNING = 2;
const MAX_WAITING = 50;
let running = 0;
const waiting: (() => void)[] = [];

/** Thrown when too many password checks are already waiting. */
export class PasswordsBusyError extends Error {}

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_RUNNING) {
    if (waiting.length >= MAX_WAITING) throw new PasswordsBusyError('Too many password checks at once.');
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    running++;
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next(); // hand the slot straight on
    else running--;
  }
}

function derive(password: string, nonce: Buffer, p: typeof PARAMS): Promise<Buffer> {
  return slot(
    () =>
      new Promise((resolve, reject) => {
        argon2('argon2id', { message: password, nonce, ...p }, (err, key) => (err ? reject(err) : resolve(key)));
      }),
  );
}

/** Returns a PHC-format string: $argon2id$v=19$m=…,t=…,p=…$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, 'base64url');
  const actual = await derive(password, Buffer.from(m[4]!, 'base64url'), {
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Used to keep login timing similar when the username doesn't exist.
let dummyHash: Promise<string> | null = null;
export function dummyVerify(password: string): Promise<boolean> {
  dummyHash ??= hashPassword('not-a-real-password');
  return dummyHash.then((h) => verifyPassword(password, h)).then(() => false);
}
