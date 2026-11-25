import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  trustProxy: boolean;
  cookieSecure: 'auto' | 'true' | 'false';
  baseUrl: string | null;
  sessionSecret: string;
  webDist: string | null;
};

const DEFAULT_PORT = 38471;

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * The session secret comes from stack.env (SESSION_SECRET). If it's missing,
 * one is generated on first boot and kept in the data dir, so a missing
 * stack.env never stops the server from starting.
 */
function resolveSessionSecret(dataDir: string, fromEnv: string | undefined): string {
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (fromEnv) throw new Error('SESSION_SECRET must be at least 32 characters.');
  const file = join(dataDir, 'session-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(48).toString('base64url');
  writeFileSync(file, secret + '\n', { mode: 0o600 });
  return secret;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.DATA_DIR || './data');
  mkdirSync(dataDir, { recursive: true });

  const port = Number(env.PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be 1-65535, got "${env.PORT}".`);

  const cookieSecure = (env.COOKIE_SECURE || 'auto').toLowerCase();
  if (!['auto', 'true', 'false'].includes(cookieSecure)) throw new Error('COOKIE_SECURE must be auto, true or false.');

  const webDist = env.WEB_DIST ? resolve(env.WEB_DIST) : resolve(import.meta.dirname, '../../web/dist');

  return {
    port,
    host: env.HOST || '0.0.0.0',
    dataDir,
    trustProxy: bool(env.TRUST_PROXY, false),
    cookieSecure: cookieSecure as Config['cookieSecure'],
    baseUrl: env.BASE_URL ? env.BASE_URL.replace(/\/+$/, '') : null,
    sessionSecret: resolveSessionSecret(dataDir, env.SESSION_SECRET),
    webDist: existsSync(webDist) ? webDist : null,
  };
}
