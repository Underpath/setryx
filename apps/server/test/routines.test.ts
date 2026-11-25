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
const workouts: Record<string, string> = {};

const req = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: object) =>
  app.inject({ method, url, payload: body, headers: { cookie } });
const cookieOf = (res: LightMyRequestResponse) => `setryx_session=${res.cookies.find((c) => c.name === 'setryx_session')!.value}`;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'setryx-test-'));
  app = await buildApp(loadConfig({ DATA_DIR: dir, WEB_DIST: join(dir, 'none') }), openDb(':memory:'));
  cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', displayName: 'Owner', password: 'owner password 1' } }));
  const ex = (await req('GET', '/api/v1/exercises?q=push')).json().exercises[0].id;
  for (const name of ['Push A', 'Pull A', 'Push B', 'Pull B']) {
    const w = await req('POST', '/api/v1/workouts', {
      name,
      items: [{ kind: 'exercise', id: 'e', exerciseId: ex, targetType: 'reps', targetReps: 10, targetDurationS: null, targetWeight: null, tempo: null, rir: null, notes: null, equipmentNote: null }],
    });
    workouts[name] = w.json().workout.id;
  }
});

const rotation = () => ({
  name: 'Push Pull',
  mode: 'repeat',
  entries: ['Push A', 'Pull A', 'Push B', 'Pull B'].map((n, i) => ({ id: `e${i}`, workoutId: workouts[n] })),
});

const finish = (id: string, workoutName: string, routineId: string | null, entryId: string | null, startedAt: number) =>
  req('PUT', `/api/v1/sessions/${id}`, {
    workoutId: workouts[workoutName], routineId, routineEntryId: entryId, workoutName, startedAt, endedAt: startedAt + 60_000, durationMs: 60_000,
    status: 'completed', items: [], exercises: {}, logs: [],
  });

test('create a routine, record sessions against it, and read the runs back', async () => {
  const res = await req('POST', '/api/v1/routines', rotation());
  assert.equal(res.statusCode, 201);
  const r = res.json().routine;
  assert.equal(r.entries.length, 4);
  assert.equal(r.entries[1].workoutName, 'Pull A');
  assert.equal(r.entries[0].weekday, null);
  assert.deepEqual(r.runs, []);

  const t = Date.now();
  assert.equal((await finish('00000000-0000-4000-8000-000000000001', 'Push A', r.id, 'e0', t)).statusCode, 200);
  assert.equal((await finish('00000000-0000-4000-8000-000000000002', 'Pull B', null, null, t + 1000)).statusCode, 200, 'a session outside the routine');
  const after = (await req('GET', `/api/v1/routines/${r.id}`)).json().routine;
  assert.deepEqual(after.runs.map((x: { entryId: string }) => x.entryId), ['e0']);
  const s = (await req('GET', '/api/v1/sessions/00000000-0000-4000-8000-000000000001')).json().session;
  assert.equal(s.routineId, r.id);
  assert.equal(s.routineEntryId, 'e0');

  // Restart: earlier runs no longer count.
  const restarted = (await req('POST', `/api/v1/routines/${r.id}/restart`)).json().routine;
  assert.deepEqual(restarted.runs, []);
});

test('pause, edit, and delete a routine; its sessions stay', async () => {
  const r = (await req('POST', '/api/v1/routines', rotation())).json().routine;
  const paused = (await req('PATCH', `/api/v1/routines/${r.id}`, { active: false })).json().routine;
  assert.equal(paused.active, false);

  const weekly = await req('PUT', `/api/v1/routines/${r.id}`, { name: 'Week', mode: 'weekly', active: true, entries: [{ id: 'e0', workoutId: workouts['Push A'], weekday: 0 }, { id: 'e1', workoutId: workouts['Pull A'], weekday: 3 }] });
  assert.equal(weekly.statusCode, 200);
  assert.deepEqual(weekly.json().routine.entries.map((e: { weekday: number }) => e.weekday), [0, 3]);

  const noDay = await req('PUT', `/api/v1/routines/${r.id}`, { name: 'Week', mode: 'weekly', entries: [{ id: 'e0', workoutId: workouts['Push A'] }] });
  assert.equal(noDay.statusCode, 400);

  await finish('00000000-0000-4000-8000-000000000003', 'Push A', r.id, 'e0', Date.now());
  assert.equal((await req('DELETE', `/api/v1/routines/${r.id}`)).statusCode, 204);
  assert.equal((await req('GET', `/api/v1/routines/${r.id}`)).statusCode, 404);
  assert.equal((await req('GET', '/api/v1/sessions/00000000-0000-4000-8000-000000000003')).statusCode, 200);
});

test('workouts must exist; a deleted workout shows as missing and can stay in the routine', async () => {
  const bad = await req('POST', '/api/v1/routines', { name: 'X', mode: 'once', entries: [{ id: 'a', workoutId: 'nope' }] });
  assert.equal(bad.statusCode, 400);

  const r = (await req('POST', '/api/v1/routines', rotation())).json().routine;
  await req('DELETE', `/api/v1/workouts/${workouts['Pull A']}`);
  const after = (await req('GET', `/api/v1/routines/${r.id}`)).json().routine;
  assert.equal(after.entries[1].workoutName, null);

  // Saving the routine again with the missing entry unchanged is fine…
  const body = { ...rotation(), name: 'Renamed' };
  assert.equal((await req('PUT', `/api/v1/routines/${r.id}`, body)).statusCode, 200);
  // …but adding the deleted workout as a new entry isn't.
  const add = { ...body, entries: [...body.entries, { id: 'e9', workoutId: workouts['Pull A'] }] };
  assert.equal((await req('PUT', `/api/v1/routines/${r.id}`, add)).statusCode, 400);
});

test('routines are in the export', async () => {
  await req('POST', '/api/v1/routines', rotation());
  const exp = (await req('GET', '/api/v1/export')).json();
  assert.equal(exp.routines.length, 1);
  assert.equal(exp.routines[0].runs, undefined);
});
