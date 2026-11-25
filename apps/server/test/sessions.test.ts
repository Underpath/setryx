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
let workoutId: string;
let pressId: string;

const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: object, as = cookie) =>
  app.inject({ method, url, payload: body, headers: as ? { cookie: as } : {} });
const cookieOf = (res: LightMyRequestResponse) => `setryx_session=${res.cookies.find((c) => c.name === 'setryx_session')!.value}`;

const SID = '0f8b6c1e-3b0a-4d2e-9f00-1a2b3c4d5e6f';

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'setryx-test-'));
  app = await buildApp(loadConfig({ DATA_DIR: dir, WEB_DIST: join(dir, 'none') }), openDb(':memory:'));
  cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', displayName: 'Owner', password: 'owner password 1' } }));
  pressId = (await req('GET', '/api/v1/exercises?q=incline%20dumbbell%20press')).json().exercises[0].id;
  const w = await req('POST', '/api/v1/workouts', {
    name: 'Push A',
    items: [
      {
        kind: 'superset', id: 'ss', label: 'Chest', rounds: 2,
        items: [
          { kind: 'exercise', id: 'press', exerciseId: pressId, targetType: 'reps', targetReps: 10, targetDurationS: null, targetWeight: 8, tempo: null, rir: null, notes: null, equipmentNote: null },
          { kind: 'rest', id: 'r', durationS: 30, label: null },
        ],
      },
    ],
  });
  workoutId = w.json().workout.id;
});

const T = Date.UTC(2026, 10, 24, 18, 0, 0);
const log = (stepIndex: number, round: number, reps: number, weight: number) => ({
  stepIndex, itemId: 'press', exerciseId: pressId, round, plannedReps: 10, actualReps: reps, plannedWeight: 8, actualWeight: weight,
  plannedDurationS: null, actualDurationS: null, completedAt: T + stepIndex * 60_000,
});
const upload = (logs = [log(0, 1, 10, 8), log(2, 2, 9, 8)]) => ({
  workoutId, workoutName: 'Push A', icon: '', startedAt: T, endedAt: T + 600_000, durationMs: 590_000, status: 'completed',
  notes: null, items: [], exercises: { [pressId]: { name: 'Incline Dumbbell Press', equipment: [], instructions: [] } }, logs,
});

test('upload a session, list it with totals, read it back', async () => {
  const put = await req('PUT', `/api/v1/sessions/${SID}`, upload());
  assert.equal(put.statusCode, 200, put.body);
  const list = (await req('GET', '/api/v1/sessions')).json().sessions;
  assert.equal(list.length, 1);
  assert.equal(list[0].setCount, 2);
  assert.equal(list[0].volumeKg, 10 * 8 + 9 * 8);
  const detail = (await req('GET', `/api/v1/sessions/${SID}`)).json().session;
  assert.equal(detail.logs[1].actualReps, 9);
  assert.equal(detail.startedAt, new Date(T).toISOString());
});

test('uploading the same session again replaces it (safe retries)', async () => {
  await req('PUT', `/api/v1/sessions/${SID}`, upload());
  await req('PUT', `/api/v1/sessions/${SID}`, upload());
  const fixed = await req('PUT', `/api/v1/sessions/${SID}`, upload([log(0, 1, 12, 8)]));
  assert.equal(fixed.statusCode, 200);
  const list = (await req('GET', '/api/v1/sessions')).json().sessions;
  assert.equal(list.length, 1);
  assert.equal(list[0].setCount, 1);
});

test('sessions are private', async () => {
  await req('PUT', `/api/v1/sessions/${SID}`, upload());
  await req('POST', '/api/v1/admin/users', { username: 'other', displayName: 'Other', password: 'other password 1' });
  const other = cookieOf(await req('POST', '/api/v1/auth/login', { username: 'other', password: 'other password 1' }, ''));
  assert.equal((await req('GET', `/api/v1/sessions/${SID}`, undefined, other)).statusCode, 404);
  assert.equal((await req('PUT', `/api/v1/sessions/${SID}`, upload(), other)).statusCode, 409);
  assert.deepEqual((await req('GET', '/api/v1/sessions', undefined, other)).json().sessions, []);
});

test('bad uploads are rejected', async () => {
  assert.equal((await req('PUT', `/api/v1/sessions/${SID}`, { ...upload(), endedAt: T - 1 })).statusCode, 400);
  assert.equal((await req('PUT', '/api/v1/sessions/not a uuid!', upload())).statusCode, 400);
  assert.equal((await req('PUT', `/api/v1/sessions/${SID}`, { ...upload(), logs: [{ ...log(0, 1, -3, 8) }] })).statusCode, 400);
});

test('target updates write what you did back into the workout', async () => {
  const res = await req('POST', `/api/v1/workouts/${workoutId}/targets`, { updates: [{ itemId: 'press', targetReps: 12, targetWeight: 8.5 }] });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().applied, 1);
  const step = (await req('GET', `/api/v1/workouts/${workoutId}`)).json().workout.items[0].items[0];
  assert.equal(step.targetReps, 12);
  assert.equal(step.targetWeight, 8.5);
  const unknown = await req('POST', `/api/v1/workouts/${workoutId}/targets`, { updates: [{ itemId: 'nope', targetReps: 5 }] });
  assert.equal(unknown.json().applied, 0);
});

test('deleting a session', async () => {
  await req('PUT', `/api/v1/sessions/${SID}`, upload());
  assert.equal((await req('DELETE', `/api/v1/sessions/${SID}`)).statusCode, 204);
  assert.equal((await req('GET', `/api/v1/sessions/${SID}`)).statusCode, 404);
});
