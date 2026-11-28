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
let cookie: string;
let writeToken: string;
let readToken: string;
let bench: string;
let row: string;

const cookieOf = (res: LightMyRequestResponse) => `setryx_session=${res.cookies.find((c) => c.name === 'setryx_session')!.value}`;
const asUser = (method: 'GET' | 'POST' | 'PATCH', url: string, body?: object) => app.inject({ method, url, payload: body, headers: { cookie } });

let nextId = 1;
const rpc = (token: string | null, method: string, params?: object, extraHeaders: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    payload: { jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) },
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: 'application/json, text/event-stream', ...extraHeaders },
  });

/** Calls a tool and returns [parsed result, isError]. */
async function call(name: string, args: object = {}, token = writeToken): Promise<[any, boolean]> {
  const res = await rpc(token, 'tools/call', { name, arguments: args });
  assert.equal(res.statusCode, 200, res.body);
  const { result } = res.json();
  const text = result.content[0].text as string;
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* plain message */
  }
  return [value, !!result.isError];
}
const ok = async (name: string, args: object = {}) => {
  const [v, isError] = await call(name, args);
  assert.equal(isError, false, `${name}: ${JSON.stringify(v)}`);
  return v;
};

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'setryx-test-'));
  app = await buildApp(loadConfig({ DATA_DIR: dir, WEB_DIST: join(dir, 'none') }), openDb(':memory:'));
  cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', displayName: 'Owner', password: 'owner password 1' } }));
  writeToken = (await asUser('POST', '/api/v1/tokens', { name: 'agent', scope: 'write', expiresInDays: null , password: 'owner password 1' })).json().secret;
  readToken = (await asUser('POST', '/api/v1/tokens', { name: 'reader', scope: 'read', expiresInDays: null , password: 'owner password 1' })).json().secret;
  await asUser('PATCH', '/api/v1/admin/mcp', { enabled: true });
  bench = (await asUser('GET', '/api/v1/exercises?q=barbell%20bench%20press')).json().exercises[0].name;
  row = (await asUser('GET', '/api/v1/exercises?q=bent%20over%20barbell%20row')).json().exercises[0].name;
});

test('the handshake: initialize, notifications, ping, and refusals', async () => {
  const init = await rpc(writeToken, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.statusCode, 200);
  const r = init.json().result;
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.equal(r.serverInfo.name, 'setryx');
  assert.ok(r.capabilities.tools);
  assert.match(r.instructions, /kilograms/);

  const note = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', method: 'notifications/initialized' }, headers: { authorization: `Bearer ${writeToken}` } });
  assert.equal(note.statusCode, 202);
  assert.deepEqual((await rpc(writeToken, 'ping')).json().result, {});
  assert.equal((await rpc(writeToken, 'nope')).json().error.code, -32601);

  const anon = await rpc(null, 'initialize', {});
  assert.equal(anon.statusCode, 401);
  assert.match(anon.headers['www-authenticate'] as string, /Bearer/);
  assert.equal((await rpc('setryx_wrong', 'tools/list')).statusCode, 401);
  assert.equal((await rpc(writeToken, 'tools/list', undefined, { origin: 'https://elsewhere.example' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/mcp' })).statusCode, 405);
});

test('read tokens only see and run the reading tools', async () => {
  const all = (await rpc(writeToken, 'tools/list')).json().result.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[];
  const reading = (await rpc(readToken, 'tools/list')).json().result.tools as { name: string }[];
  assert.ok(all.length > reading.length);
  assert.ok(reading.every((t) => all.find((a) => a.name === t.name)!.annotations.readOnlyHint));
  assert.ok(all.find((t) => t.name === 'delete_routine')!.annotations.destructiveHint);
  // Tools that overwrite what's there are flagged too, so clients that confirm destructive calls ask first.
  for (const name of ['update_exercise', 'update_workout', 'edit_routine']) assert.ok(all.find((t) => t.name === name)!.annotations.destructiveHint, name);
  assert.equal(all.find((t) => t.name === 'update_targets')!.annotations.destructiveHint, false);
  assert.equal(all.some((t) => t.name === 'delete_session'), false, 'session history can’t be deleted over MCP');

  const [msg, isError] = await call('create_exercise', { name: 'Sneaky' }, readToken);
  assert.equal(isError, true);
  assert.match(msg, /can only read/);
});

test('MCP is off until an admin turns it on, and can be turned off again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'setryx-test-'));
  const fresh = await buildApp(loadConfig({ DATA_DIR: dir, WEB_DIST: join(dir, 'none') }), openDb(':memory:'));
  const owner = cookieOf(await fresh.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', displayName: 'Owner', password: 'owner password 1' } }));
  const t = (await fresh.inject({ method: 'POST', url: '/api/v1/tokens', payload: { name: 'a', scope: 'read', expiresInDays: null , password: 'owner password 1' }, headers: { cookie: owner } })).json();
  assert.equal(t.token.scope, 'read');
  assert.equal((await fresh.inject({ method: 'GET', url: '/api/v1/tokens', headers: { cookie: owner } })).json().mcpEnabled, false);
  assert.equal((await fresh.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'ping' }, headers: { authorization: `Bearer ${t.secret}` } })).statusCode, 404);

  assert.equal((await asUser('PATCH', '/api/v1/admin/mcp', { enabled: false })).json().enabled, false);
  assert.equal((await rpc(writeToken, 'tools/list')).statusCode, 404);
  assert.equal((await asUser('GET', '/api/v1/tokens')).json().mcpEnabled, false);
  // The REST API still works.
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/workouts', headers: { authorization: `Bearer ${writeToken}` } })).statusCode, 200);
  await asUser('PATCH', '/api/v1/admin/mcp', { enabled: true });
  assert.equal((await rpc(writeToken, 'tools/list')).statusCode, 200);
});

test('workouts by name: create with sets, read back, change targets', async () => {
  const w = await ok('create_workout', {
    name: 'Upper A',
    icon: '💪',
    items: [
      { exercise: bench, reps: 8, weight: 60, sets: 3, restS: 90 },
      { rest: 120 },
      { superset: 'Row and plank', rounds: 2, items: [{ exercise: row, reps: 10, weight: 40 }, { exercise: 'plank', durationS: 45 }, { rest: 30 }] },
    ],
  });
  assert.equal(w.name, 'Upper A');
  assert.equal(w.items.length, 3);
  assert.deepEqual([w.items[0].superset, w.items[0].rounds, w.items[0].items[0].reps, w.items[0].items[1].rest], [bench, 3, 8, 90]);
  assert.equal(w.items[2].items[1].durationS, 45);

  const got = await ok('get_workout', { workout: 'upper a' });
  assert.deepEqual(got.items, w.items, 'names are case-insensitive and the shape round-trips');

  const t = await ok('update_targets', { workout: 'Upper A', changes: [{ exercise: bench, weight: 62.5 }] });
  assert.equal(t.changedSteps, 1);
  assert.equal(t.workout.items[0].items[0].weight, 62.5);

  // Editing steps keeps ids that were passed back.
  const edited = got.items;
  edited[2].rounds = 3;
  const u = await ok('update_workout', { workout: 'Upper A', items: edited, notes: 'Heavy day' });
  assert.equal(u.items[2].rounds, 3);
  assert.equal(u.items[2].id, got.items[2].id);
  assert.equal(u.notes, 'Heavy day');

  const [miss, isError] = await call('get_workout', { workout: 'Uper A' });
  assert.equal(isError, true);
  assert.match(miss, /Did you mean: “Upper A”/);
  const [noReps] = await call('create_workout', { name: 'Bad', items: [{ exercise: bench }] });
  assert.match(noReps, /Give reps or durationS/);
});

test('routines: rotation, logging a session against it, and an edit that keeps the place', async () => {
  for (const name of ['Push', 'Pull', 'Legs']) await ok('create_workout', { name, items: [{ exercise: bench, reps: 5, weight: 50 }] });
  const r = await ok('create_routine', { name: 'PPL', mode: 'repeat', workouts: [{ workout: 'Push' }, { workout: 'Pull' }, { workout: 'Legs' }] });
  assert.equal(r.status.next, 'Push');

  const logged = await ok('log_session', { workout: 'Push', startedAt: new Date().toISOString(), durationMinutes: 1, sets: [{ exercise: bench, reps: 5, weight: 52.5 }, { exercise: bench, reps: 4, weight: 52.5 }] });
  assert.equal(logged.countedForRoutine, 'PPL');
  assert.deepEqual(logged.sets[bench], ['5 × 52.5 kg', '4 × 52.5 kg']);

  const next = await ok('whats_next');
  assert.equal(next.active[0].next, 'Pull');

  // Swap Legs for a new workout: the rotation stays on Pull.
  const [, legsFailed] = await call('create_workout', { name: 'Legs B', items: [{ exercise: row, reps: 5 }] });
  assert.equal(legsFailed, false);
  const edited = await ok('edit_routine', { routine: 'PPL', workouts: [{ workout: 'Push' }, { workout: 'Pull' }, { workout: 'Legs B' }] });
  assert.equal(edited.status.next, 'Pull');

  assert.deepEqual(await ok('pause_routine', { routine: 'PPL' }), { paused: 'PPL' });
  assert.deepEqual((await ok('whats_next')).paused, ['PPL']);
  assert.equal((await ok('resume_routine', { routine: 'PPL' })).status.next, 'Pull');
  assert.equal((await ok('reset_routine_progress', { routine: 'PPL' })).status.next, 'Push');

  const weekly = await ok('create_routine', { name: 'Week', mode: 'weekly', workouts: [{ workout: 'Push', day: 'mon' }, { workout: 'Pull', day: 'Thursday' }] });
  assert.deepEqual(weekly.workouts.map((x: { day: string }) => x.day), ['Monday', 'Thursday']);
  const [noDay] = await call('create_routine', { name: 'Bad', mode: 'weekly', workouts: [{ workout: 'Push' }] });
  assert.match(noDay, /need a day/);

  const summary = await ok('training_summary');
  assert.equal(summary.latestSessions.length, 1);
  assert.equal(summary.topExercises[0].exercise, bench);
  const history = await ok('exercise_history', { exercise: bench });
  assert.equal(history.sessions, 1);
  assert.equal(history.bests.weight, 52.5);
  const sessions = await ok('list_sessions');
  assert.equal((await ok('get_session', { session: sessions[0].id })).workout, 'Push');
});

test('own exercises: create, update, delete; library ones are protected', async () => {
  const ex = await ok('create_exercise', { name: 'Sled push', equipment: ['sled'], primaryMuscles: ['quadriceps'] });
  assert.equal(ex.isCustom, true);
  const up = await ok('update_exercise', { exercise: 'sled push', name: 'Heavy sled push' });
  assert.deepEqual([up.name, up.equipment], ['Heavy sled push', ['sled']]);
  assert.equal((await ok('search_exercises', { mine: true })).total, 1);
  assert.deepEqual(await ok('delete_exercise', { exercise: 'Heavy sled push' }), { deleted: 'Heavy sled push' });
  const [msg, isError] = await call('update_exercise', { exercise: bench, name: 'Mine now' });
  assert.equal(isError, true);
  assert.match(msg, /library exercise/);
  const [bad] = await call('create_exercise', { name: 42 });
  assert.match(bad, /Some arguments need fixing/);
});

test('form cues: notes on a step land on the exercise, and set_exercise_cues replaces them', async () => {
  const w = (await ok('create_workout', { name: 'Push', items: [{ exercise: bench, reps: 5, weight: 50, notes: 'Elbows at 45°' }] })) as { items: { cues?: string; notes?: string }[] };
  assert.equal(w.items[0]!.cues, 'Elbows at 45°');
  assert.equal(w.items[0]!.notes, undefined);
  const ex = (await ok('set_exercise_cues', { exercise: bench, cues: 'Feet planted' })) as { cues: string };
  assert.equal(ex.cues, 'Feet planted');
  assert.equal(((await ok('get_exercise', { exercise: bench })) as { cues: string }).cues, 'Feet planted');
  const got = (await ok('get_workout', { workout: 'Push' })) as { items: { cues?: string }[] };
  assert.equal(got.items[0]!.cues, 'Feet planted');
  const [, isError] = await call('set_exercise_cues', { exercise: bench, cues: 'x' }, readToken);
  assert.equal(isError, true, 'read tokens can’t');
});
