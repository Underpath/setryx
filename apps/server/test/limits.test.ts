import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { defaultLimitSettings, type LimitSettings } from '@setryx/shared';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { RateLimiter } from '../src/limits.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
let app: FastifyInstance;
let cookie: string;

const cookieOf = (res: LightMyRequestResponse) => `setryx_session=${res.cookies.find((c) => c.name === 'setryx_session')!.value}`;
const asUser = (method: Method, url: string, body?: object, who = cookie) => app.inject({ method, url, payload: body, headers: { cookie: who } });
const withToken = (token: string, method: Method, url: string) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
const setLimits = async (patch: Partial<LimitSettings>) => {
  const res = await asUser('PUT', '/api/v1/admin/limits', { ...defaultLimitSettings, ...patch });
  assert.equal(res.statusCode, 200, res.body);
};
const newToken = async () => (await asUser('POST', '/api/v1/tokens', { name: 'agent', scope: 'write', expiresInDays: null })).json().secret as string;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'setryx-test-'));
  app = await buildApp(loadConfig({ DATA_DIR: dir, WEB_DIST: join(dir, 'none') }), openDb(':memory:'));
  cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', displayName: 'Owner', password: 'owner password 1' } }));
});

test('the limiter allows a minute’s worth at once, then refills steadily', () => {
  const l = new RateLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 60; i++) assert.equal(l.take('k', 60, 1, t0).ok, true);
  const over = l.take('k', 60, 1, t0);
  assert.deepEqual(over, { ok: false, retryAfterS: 1 });
  assert.equal(l.take('k', 60, 1, t0 + 1000).ok, true); // one a second at 60 a minute
  assert.equal(l.take('k', 60, 1, t0 + 1000).ok, false);
  assert.equal(l.take('other', 60, 1, t0).ok, true); // keys are separate
  assert.deepEqual(l.take('k', 60, 5, t0 + 1000), { ok: false, retryAfterS: 5 });
});

test('admins read and change the limits; others can’t, and bad values are refused', async () => {
  assert.deepEqual((await asUser('GET', '/api/v1/admin/limits')).json(), defaultLimitSettings);
  await setLimits({ tokenPerMinute: null, maxTokensPerUser: 5 });
  assert.deepEqual((await asUser('GET', '/api/v1/admin/limits')).json(), { ...defaultLimitSettings, tokenPerMinute: null, maxTokensPerUser: 5 });

  const bad = await asUser('PUT', '/api/v1/admin/limits', { ...defaultLimitSettings, appPerMinute: 5, signInPerMinute: 2.5 });
  assert.equal(bad.statusCode, 400);
  assert.ok(bad.json().fields.appPerMinute);
  assert.ok(bad.json().fields.signInPerMinute);

  await asUser('POST', '/api/v1/admin/users', { username: 'pat', displayName: 'Pat', password: 'pat password 12', role: 'user' });
  const pat = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'pat', password: 'pat password 12' } }));
  assert.equal((await asUser('GET', '/api/v1/admin/limits', undefined, pat)).statusCode, 403);
  assert.equal((await asUser('PUT', '/api/v1/admin/limits', defaultLimitSettings, pat)).statusCode, 403);
  assert.deepEqual((await asUser('GET', '/api/v1/tokens', undefined, pat)).json().limits, { perMinute: null, maxTokens: 5 });
});

test('a token over its limit gets 429 with Retry-After; other tokens and the app carry on', async () => {
  await setLimits({ tokenPerMinute: 10 });
  const a = await newToken();
  const b = await newToken();
  for (let i = 0; i < 10; i++) {
    const res = await withToken(a, 'GET', '/api/v1/workouts');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['ratelimit-limit'], '10');
  }
  const over = await withToken(a, 'GET', '/api/v1/workouts');
  assert.equal(over.statusCode, 429);
  assert.equal(over.json().error, 'rate_limited');
  assert.match(over.json().message, /more than 10 requests a minute/);
  assert.ok(Number(over.headers['retry-after']) >= 1);
  assert.equal((await withToken(b, 'GET', '/api/v1/workouts')).statusCode, 200);
  assert.equal((await asUser('GET', '/api/v1/workouts')).statusCode, 200);

  await setLimits({ tokenPerMinute: null });
  assert.equal((await withToken(a, 'GET', '/api/v1/workouts')).statusCode, 200);
});

test('an MCP call counts once, however many API calls its tool makes, and batches count each message', async () => {
  await asUser('PATCH', '/api/v1/admin/mcp', { enabled: true });
  await setLimits({ tokenPerMinute: 10 });
  const token = await newToken();
  let id = 1;
  const rpc = (payload: object | object[]) => app.inject({ method: 'POST', url: '/mcp', payload, headers: { authorization: `Bearer ${token}` } });
  const call = () => ({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'whats_next', arguments: {} } });
  for (let i = 0; i < 6; i++) {
    const res = await rpc(call());
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().result.isError, undefined, res.body);
  }
  assert.equal((await rpc([call(), call(), call(), call(), call()])).statusCode, 429); // 6 + 5 > 10
  const ping = await rpc([call(), call(), call(), call()]);
  assert.equal(ping.statusCode, 200);
  const over = await rpc(call());
  assert.equal(over.statusCode, 429);
  assert.match(over.json().error.message, /more than 10 requests a minute/);
});

test('the app limit applies per person, and photos aren’t counted', async () => {
  await setLimits({ appPerMinute: 60 });
  // Lowering a limit caps what's left at the new value.
  for (let i = 0; i < 60; i++) assert.equal((await asUser('GET', '/api/v1/workouts')).statusCode, 200);
  assert.equal((await asUser('GET', '/api/v1/exercise-images/a/0.jpg')).statusCode, 404);
  const over = await asUser('GET', '/api/v1/workouts');
  assert.equal(over.statusCode, 429);
  assert.match(over.json().message, /^You made more than 60 requests a minute/);
});

test('sign-in attempts follow the admin’s limit, and token count is capped', async () => {
  await setLimits({ signInPerMinute: 3, maxTokensPerUser: 1 });
  const login = () => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'owner', password: 'wrong password 1' } });
  for (let i = 0; i < 3; i++) assert.equal((await login()).statusCode, 401);
  assert.equal((await login()).statusCode, 429);

  await newToken();
  const second = await asUser('POST', '/api/v1/tokens', { name: 'two', scope: 'read', expiresInDays: 30 });
  assert.equal(second.statusCode, 400);
  assert.equal(second.json().error, 'too_many_tokens');
  assert.match(second.json().message, /You have a token, the most this server allows/);
});
