import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';

let app: FastifyInstance;

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'setryx-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, WEB_DIST: join(dataDir, 'none') });
  app = await buildApp(config, openDb(':memory:'));
});

function cookieOf(res: LightMyRequestResponse): string {
  const c = res.cookies.find((c) => c.name === 'setryx_session');
  assert.ok(c, 'expected a session cookie');
  return `setryx_session=${c.value}`;
}

const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, opts: { body?: object; cookie?: string; origin?: string } = {}) =>
  app.inject({
    method,
    url,
    payload: opts.body,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.origin ? { origin: opts.origin } : {}) },
  });

const admin = { username: 'Alice', displayName: 'Alice', password: 'correct horse battery' };

async function setupAdmin(): Promise<string> {
  const res = await req('POST', '/api/v1/setup', { body: admin });
  assert.equal(res.statusCode, 201, res.body);
  return cookieOf(res);
}

test('health check', async () => {
  const res = await req('GET', '/api/health');
  assert.deepEqual(res.json(), { ok: true });
});

test('first user becomes admin, and setup only works once', async () => {
  assert.deepEqual((await req('GET', '/api/v1/setup')).json(), { needsSetup: true });
  const cookie = await setupAdmin();
  const me = (await req('GET', '/api/v1/auth/me', { cookie })).json();
  assert.equal(me.user.role, 'admin');
  assert.equal(me.user.username, 'alice', 'usernames are lower-cased');
  assert.equal(me.user.passwordHash, undefined, 'never leaks the hash');
  assert.deepEqual((await req('GET', '/api/v1/setup')).json(), { needsSetup: false });
  const again = await req('POST', '/api/v1/setup', { body: { ...admin, username: 'other' } });
  assert.equal(again.statusCode, 409);
});

test('login, wrong password, logout', async () => {
  await setupAdmin();
  const bad = await req('POST', '/api/v1/auth/login', { body: { username: 'alice', password: 'nope nope nope' } });
  assert.equal(bad.statusCode, 401);
  const unknown = await req('POST', '/api/v1/auth/login', { body: { username: 'ghost', password: 'nope nope nope' } });
  assert.equal(unknown.statusCode, 401);
  const ok = await req('POST', '/api/v1/auth/login', { body: { username: 'ALICE', password: admin.password } });
  assert.equal(ok.statusCode, 200);
  const cookie = cookieOf(ok);
  assert.equal((await req('POST', '/api/v1/auth/logout', { cookie })).statusCode, 204);
  assert.equal((await req('GET', '/api/v1/auth/me', { cookie })).statusCode, 401, 'session is gone after logout');
});

test('weak input is rejected with field messages', async () => {
  const res = await req('POST', '/api/v1/setup', { body: { username: 'a', displayName: '', password: 'short' } });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.ok(body.fields.username && body.fields.password && body.fields.displayName);
});

test('cross-site POSTs are blocked', async () => {
  const cookie = await setupAdmin();
  const res = await req('PATCH', '/api/v1/me', { cookie, origin: 'https://evil.example', body: { displayName: 'x' } });
  assert.equal(res.statusCode, 403);
});

test('admin creates a user; non-admins cannot use admin routes', async () => {
  const cookie = await setupAdmin();
  const created = await req('POST', '/api/v1/admin/users', {
    cookie,
    body: { username: 'alex', displayName: 'Alex', password: 'alex password 1' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const dup = await req('POST', '/api/v1/admin/users', {
    cookie,
    body: { username: 'Alex', displayName: 'Alex', password: 'alex password 1' },
  });
  assert.equal(dup.statusCode, 409);

  const alex = cookieOf(await req('POST', '/api/v1/auth/login', { body: { username: 'alex', password: 'alex password 1' } }));
  assert.equal((await req('GET', '/api/v1/admin/users', { cookie: alex })).statusCode, 403);
  assert.equal((await req('GET', '/api/v1/admin/users')).statusCode, 401);
});

test('disabling a user signs them out; the last admin is protected', async () => {
  const cookie = await setupAdmin();
  const { user } = (
    await req('POST', '/api/v1/admin/users', { cookie, body: { username: 'alex', displayName: 'Alex', password: 'alex password 1' } })
  ).json();
  const alex = cookieOf(await req('POST', '/api/v1/auth/login', { body: { username: 'alex', password: 'alex password 1' } }));
  await req('PATCH', `/api/v1/admin/users/${user.id}`, { cookie, body: { disabled: true } });
  assert.equal((await req('GET', '/api/v1/auth/me', { cookie: alex })).statusCode, 401);
  const relogin = await req('POST', '/api/v1/auth/login', { body: { username: 'alex', password: 'alex password 1' } });
  assert.equal(relogin.statusCode, 401, 'a turned-off account looks like a wrong password');
  assert.equal(relogin.json().error, 'bad_credentials');

  const me = (await req('GET', '/api/v1/auth/me', { cookie })).json().user;
  const demote = await req('PATCH', `/api/v1/admin/users/${me.id}`, { cookie, body: { role: 'user' } });
  assert.equal(demote.statusCode, 409);
});

test('invite links: register once, then the link is spent', async () => {
  const cookie = await setupAdmin();
  const closed = await req('POST', '/api/v1/auth/register', {
    body: { username: 'joan', displayName: 'Jo', password: 'jo password 12' },
  });
  assert.equal(closed.statusCode, 403, 'signup is closed by default');

  const { url } = (await req('POST', '/api/v1/admin/invites', { cookie, body: {} })).json();
  const token = url.split('/invite/')[1];
  assert.equal((await req('GET', `/api/v1/auth/signup-info?invite=${token}`)).json().invite, 'valid');

  const reg = await req('POST', '/api/v1/auth/register', {
    body: { username: 'joan', displayName: 'Jo', password: 'jo password 12', inviteToken: token },
  });
  assert.equal(reg.statusCode, 201, reg.body);
  assert.equal(reg.json().user.role, 'user');

  const reuse = await req('POST', '/api/v1/auth/register', {
    body: { username: 'joan2', displayName: 'Jo', password: 'jo password 12', inviteToken: token },
  });
  assert.equal(reuse.statusCode, 410);
  const list = (await req('GET', '/api/v1/admin/invites', { cookie })).json().invites;
  assert.equal(list[0].status, 'used');
  assert.equal(list[0].usedBy, 'joan');
});

test('open signup can be switched on', async () => {
  const cookie = await setupAdmin();
  await req('PATCH', '/api/v1/admin/settings', { cookie, body: { openSignup: true } });
  const reg = await req('POST', '/api/v1/auth/register', {
    body: { username: 'sam', displayName: 'Sam', password: 'sam password 12' },
  });
  assert.equal(reg.statusCode, 201);
});

test('changing your password signs out other devices', async () => {
  const phone = await setupAdmin();
  const laptop = cookieOf(await req('POST', '/api/v1/auth/login', { body: { username: 'alice', password: admin.password } }));
  const wrong = await req('POST', '/api/v1/me/password', {
    cookie: phone,
    body: { currentPassword: 'wrong wrong', newPassword: 'a brand new password' },
  });
  assert.equal(wrong.statusCode, 400);
  const ok = await req('POST', '/api/v1/me/password', {
    cookie: phone,
    body: { currentPassword: admin.password, newPassword: 'a brand new password' },
  });
  assert.equal(ok.statusCode, 204);
  assert.equal((await req('GET', '/api/v1/auth/me', { cookie: phone })).statusCode, 200);
  assert.equal((await req('GET', '/api/v1/auth/me', { cookie: laptop })).statusCode, 401);
});

test('settings are merged and validated', async () => {
  const cookie = await setupAdmin();
  const res = await req('PATCH', '/api/v1/me', { cookie, body: { settings: { tapToLog: false } } });
  assert.equal(res.json().user.settings.tapToLog, false);
  assert.equal(res.json().user.settings.keepAwake, true);
  const bad = await req('PATCH', '/api/v1/me', { cookie, body: { settings: { warnSeconds: 999 } } });
  assert.equal(bad.statusCode, 400);
});

test('serves the web app: SPA routes get index.html, missing assets get 404', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'setryx-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  const web = await buildApp(loadConfig({ DATA_DIR: dir, WEB_DIST: dir }), openDb(':memory:'));
  const page = await web.inject({ method: 'GET', url: '/settings/admin' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /id="root"/);
  writeFileSync(join(dir, 'assets', 'later.js'), 'console.log(2)'); // added after start, like a rebuild
  const later = await web.inject({ method: 'GET', url: '/assets/later.js' });
  assert.equal(later.statusCode, 200);
  assert.match(String(later.headers['content-type']), /javascript/);
  const missing = await web.inject({ method: 'GET', url: '/assets/gone.js' });
  assert.equal(missing.statusCode, 404);
  const api404 = await web.inject({ method: 'GET', url: '/api/v1/nope' });
  assert.equal(api404.json().error, 'not_found');
});

test('the Docker image includes every folder the server reads at runtime', async () => {
  const { readFileSync } = await import('node:fs');
  const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
  for (const dir of ['apps/server/src', 'apps/server/seed', 'apps/web/dist', 'packages/shared']) {
    assert.match(dockerfile, new RegExp(`COPY --from=build /app/${dir} `), `Dockerfile must copy ${dir}`);
  }
});
