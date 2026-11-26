import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { type DB, openDb } from '../src/db.ts';
import { tokenMayUse } from '../src/api-tokens.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
let app: FastifyInstance;
let db: DB;
let cookie: string;

const cookieOf = (res: LightMyRequestResponse) => `setryx_session=${res.cookies.find((c) => c.name === 'setryx_session')!.value}`;
const asUser = (method: Method, url: string, body?: object) => app.inject({ method, url, payload: body, headers: { cookie } });
const withToken = (token: string, method: Method, url: string, body?: object) =>
  app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${token}` } });
const newToken = async (scope: 'read' | 'write', expiresInDays: 30 | null = null) => {
  const res = await asUser('POST', '/api/v1/tokens', { name: `${scope} token`, scope, expiresInDays });
  assert.equal(res.statusCode, 201);
  return res.json() as { token: { id: string; hint: string; scope: string }; secret: string };
};

const workout = (exerciseId: string) => ({
  name: 'Agent made',
  items: [{ kind: 'exercise', id: 'a', exerciseId, targetType: 'reps', targetReps: 8, targetDurationS: null, targetWeight: 20, tempo: null, rir: null, notes: null, equipmentNote: null }],
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'setryx-test-'));
  db = openDb(':memory:');
  app = await buildApp(loadConfig({ DATA_DIR: dir, WEB_DIST: join(dir, 'none') }), db);
  cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', displayName: 'Owner', password: 'owner password 1' } }));
});

test('a token is shown once, listed by its hint, and works until revoked', async () => {
  const { token, secret } = await newToken('read');
  assert.match(secret, /^setryx_[A-Za-z0-9_-]{43}$/);
  assert.ok(secret.startsWith(token.hint.replace('…', '')));
  const list = (await asUser('GET', '/api/v1/tokens')).json().tokens;
  assert.equal(list.length, 1);
  assert.equal(JSON.stringify(list).includes(secret), false);

  const me = await withToken(secret, 'GET', '/api/v1/auth/me');
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.username, 'owner');
  assert.ok((await asUser('GET', '/api/v1/tokens')).json().tokens[0].lastUsedAt);

  assert.equal((await asUser('DELETE', `/api/v1/tokens/${token.id}`)).statusCode, 204);
  const after = await withToken(secret, 'GET', '/api/v1/auth/me');
  assert.equal(after.statusCode, 401);
  assert.equal(after.json().error, 'invalid_token');
});

test('wrong, malformed and expired tokens are refused', async () => {
  assert.equal((await withToken('setryx_nope', 'GET', '/api/v1/workouts')).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/workouts', headers: { authorization: 'Basic abc' } })).statusCode, 401);
  const { token, secret } = await newToken('read', 30);
  db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), token.id);
  assert.equal((await withToken(secret, 'GET', '/api/v1/workouts')).statusCode, 401);
  assert.equal((await asUser('GET', '/api/v1/tokens')).json().tokens.length, 0, 'expired tokens are cleaned up');
});

test('a token ignores cookies and skips the Origin check, but only for itself', async () => {
  const { secret } = await newToken('write');
  const ex = (await withToken(secret, 'GET', '/api/v1/exercises?q=bench')).json().exercises[0].id;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/workouts',
    payload: workout(ex),
    headers: { authorization: `Bearer ${secret}`, origin: 'https://elsewhere.example' },
  });
  assert.equal(res.statusCode, 201);
  // A cookie request from another site is still blocked.
  const cross = await app.inject({ method: 'POST', url: '/api/v1/workouts', payload: workout(ex), headers: { cookie, origin: 'https://elsewhere.example' } });
  assert.equal(cross.statusCode, 403);
});

test('a read token can read everything it covers and change nothing', async () => {
  const { secret } = await newToken('read');
  for (const url of ['/api/v1/exercises', '/api/v1/exercises/facets', '/api/v1/workouts', '/api/v1/routines', '/api/v1/sessions', '/api/v1/stats/exercises', '/api/v1/stats/sessions']) {
    assert.equal((await withToken(secret, 'GET', url)).statusCode, 200, url);
  }
  const ex = (await withToken(secret, 'GET', '/api/v1/exercises?q=bench')).json().exercises[0].id;
  const res = await withToken(secret, 'POST', '/api/v1/workouts', workout(ex));
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'read_only_token');
  assert.equal((await asUser('GET', '/api/v1/workouts')).json().workouts.length, 0);
});

test('a write token can create, change and delete exercises, workouts and routines', async () => {
  const { secret } = await newToken('write');
  const t = (m: Method, url: string, body?: object) => withToken(secret, m, url, body);

  const ex = await t('POST', '/api/v1/exercises', { name: 'Sled push', equipment: ['sled'] });
  assert.equal(ex.statusCode, 201);
  const exId = ex.json().exercise.id;
  assert.equal((await t('PUT', `/api/v1/exercises/${exId}`, { name: 'Heavy sled push' })).json().exercise.name, 'Heavy sled push');

  const w = await t('POST', '/api/v1/workouts', workout(exId));
  assert.equal(w.statusCode, 201);
  const wId = w.json().workout.id;
  const targets = await t('POST', `/api/v1/workouts/${wId}/targets`, { updates: [{ itemId: 'a', targetReps: 10 }] });
  assert.equal(targets.json().workout.items[0].targetReps, 10);
  assert.equal((await t('POST', `/api/v1/workouts/${wId}/duplicate`)).statusCode, 201);

  const r = await t('POST', '/api/v1/routines', { name: 'Loop', mode: 'repeat', entries: [{ id: 'e1', workoutId: wId }] });
  assert.equal(r.statusCode, 201);
  const rId = r.json().routine.id;
  assert.equal((await t('PATCH', `/api/v1/routines/${rId}`, { active: false })).json().routine.active, false);
  assert.equal((await t('POST', `/api/v1/routines/${rId}/restart`)).statusCode, 200);
  assert.equal((await t('DELETE', `/api/v1/routines/${rId}`)).statusCode, 204);
  assert.equal((await t('DELETE', `/api/v1/workouts/${wId}`)).statusCode, 204);
  assert.equal((await t('DELETE', `/api/v1/exercises/${exId}`)).statusCode, 204);

  // Everything happened as the token's owner.
  assert.equal((await asUser('GET', '/api/v1/workouts')).json().workouts.length, 1, 'the duplicate is left');
});

test('no token reaches account, admin, token, import or photo endpoints', async () => {
  const { secret } = await newToken('write');
  const blocked: [Method, string, object?][] = [
    ['PATCH', '/api/v1/me', { displayName: 'Hacked' }],
    ['POST', '/api/v1/me/password', { currentPassword: 'x', newPassword: 'another password 1' }],
    ['POST', '/api/v1/auth/logout'],
    ['GET', '/api/v1/tokens'],
    ['POST', '/api/v1/tokens', { name: 'more', scope: 'write', expiresInDays: null }],
    ['GET', '/api/v1/admin/users'],
    ['PATCH', '/api/v1/admin/exercise-images', { allowed: true }],
    ['PUT', '/api/v1/admin/backups', { dir: '/tmp', keep: 3, latestEveryMinutes: 15 }],
    ['POST', '/api/v1/admin/invites', {}],
    ['GET', '/api/v1/export'],
    ['POST', '/api/v1/import/routines', { data: {}, choices: {} }],
    ['GET', '/api/v1/exercise-images/Some_Exercise/0.jpg'],
  ];
  for (const [m, url, body] of blocked) {
    const res = await withToken(secret, m, url, body);
    assert.equal(res.statusCode, 403, `${m} ${url}`);
    assert.equal(res.json().error, 'not_allowed_with_token', `${m} ${url}`);
  }
  assert.equal((await asUser('GET', '/api/v1/auth/me')).json().user.displayName, 'Owner');
});

test('the access rules', () => {
  assert.equal(tokenMayUse('read', 'GET', '/api/v1/workouts/:id'), 'ok');
  assert.equal(tokenMayUse('read', 'PUT', '/api/v1/workouts/:id'), 'read_only');
  assert.equal(tokenMayUse('write', 'PUT', '/api/v1/sessions/:id'), 'ok');
  assert.equal(tokenMayUse('write', 'GET', '/api/v1/exercise-images/:dir/:file'), 'not_allowed');
  assert.equal(tokenMayUse('write', 'PATCH', '/api/v1/auth/me'), 'not_allowed');
  assert.equal(tokenMayUse('write', 'GET', '/api/v1/admin/settings'), 'not_allowed');
});

test('tokens stop working when the account is disabled or an admin resets the password', async () => {
  const other = await asUser('POST', '/api/v1/admin/users', { username: 'friend', displayName: 'Friend', password: 'friend password 1' });
  const friendId = other.json().user.id;
  const friendCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'friend', password: 'friend password 1' } }));
  const make = async () =>
    (await app.inject({ method: 'POST', url: '/api/v1/tokens', payload: { name: 'f', scope: 'read', expiresInDays: null }, headers: { cookie: friendCookie } })).json().secret as string;

  const first = await make();
  await asUser('PATCH', `/api/v1/admin/users/${friendId}`, { disabled: true });
  assert.equal((await withToken(first, 'GET', '/api/v1/workouts')).statusCode, 401);
  await asUser('PATCH', `/api/v1/admin/users/${friendId}`, { disabled: false });
  assert.equal((await withToken(first, 'GET', '/api/v1/workouts')).statusCode, 200, 'back on: the token works again');

  await asUser('POST', `/api/v1/admin/users/${friendId}/password`, { password: 'reset password 1' });
  assert.equal((await withToken(first, 'GET', '/api/v1/workouts')).statusCode, 401);
});

test('each person only sees their own data through a token', async () => {
  const { secret } = await newToken('write');
  const ex = (await withToken(secret, 'GET', '/api/v1/exercises?q=bench')).json().exercises[0].id;
  const wId = (await asUser('POST', '/api/v1/workouts', workout(ex))).json().workout.id;
  await asUser('POST', '/api/v1/admin/users', { username: 'friend', displayName: 'Friend', password: 'friend password 1' });
  const friendCookie = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'friend', password: 'friend password 1' } }));
  const friendToken = (await app.inject({ method: 'POST', url: '/api/v1/tokens', payload: { name: 'f', scope: 'write', expiresInDays: null }, headers: { cookie: friendCookie } })).json().secret;
  assert.equal((await withToken(friendToken, 'GET', `/api/v1/workouts/${wId}`)).statusCode, 404);
  assert.equal((await withToken(friendToken, 'DELETE', `/api/v1/workouts/${wId}`)).statusCode, 404);
  assert.equal((await withToken(friendToken, 'GET', '/api/v1/workouts')).json().workouts.length, 0);
});

test('the OpenAPI document is public and lists only what tokens can use', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
  assert.equal(res.statusCode, 200);
  const doc = res.json();
  assert.equal(doc.openapi, '3.1.0');
  const paths = Object.keys(doc.paths);
  assert.ok(paths.includes('/workouts/{id}'));
  for (const p of paths) {
    const route = `/api/v1${p.replace(/\{(\w+)\}/g, ':$1')}`;
    for (const method of Object.keys(doc.paths[p]).filter((k) => k !== 'parameters')) {
      assert.equal(tokenMayUse('write', method.toUpperCase(), route), 'ok', `${method} ${p}`);
    }
  }
});
