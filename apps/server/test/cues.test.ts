import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { type DB, openDb } from '../src/db.ts';
import { migrations } from '../src/migrations.ts';

// Form cues belong to the exercise, one set per person, in every workout.

let app: FastifyInstance;
let db: DB;
let cookie: string;

const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: object, as = cookie) =>
  app.inject({ method, url, payload: body, headers: as ? { cookie: as } : {} });
const cookieOf = (res: LightMyRequestResponse) => `setryx_session=${res.cookies.find((c) => c.name === 'setryx_session')!.value}`;
const step = (exerciseId: string, id: string, notes: string | null = null) => ({
  kind: 'exercise', id, exerciseId, targetType: 'reps', targetReps: 10, targetDurationS: null, targetWeight: 8, tempo: null, rir: null, notes, equipmentNote: null,
});

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'setryx-test-'));
  db = openDb(':memory:');
  app = await buildApp(loadConfig({ DATA_DIR: dataDir, WEB_DIST: join(dataDir, 'none') }), db);
  cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', displayName: 'Owner', password: 'owner password 1' } }));
});

const bench = 'lib:Dumbbell_Bench_Press';

test('cues on a library exercise are yours alone and show wherever the exercise does', async () => {
  let res = await req('PUT', `/api/v1/exercises/${bench}/cues`, { cues: '  Elbows at 45°\nDrive feet into the floor  ' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().exercise.cues, 'Elbows at 45°\nDrive feet into the floor');
  assert.equal((await req('GET', `/api/v1/exercises/${bench}`)).json().exercise.cues, 'Elbows at 45°\nDrive feet into the floor');
  assert.equal((await req('GET', '/api/v1/exercises?q=dumbbell%20bench%20press')).json().exercises.find((e: { id: string }) => e.id === bench).cues, 'Elbows at 45°\nDrive feet into the floor');

  // In a workout's exercises too.
  const w = (await req('POST', '/api/v1/workouts', { name: 'Push', icon: '', items: [step(bench, 's1')] })).json();
  assert.equal((await req('GET', `/api/v1/workouts/${w.workout.id}`)).json().exercises[bench].cues, 'Elbows at 45°\nDrive feet into the floor');

  // Someone else sees none.
  await req('POST', '/api/v1/admin/users', { username: 'pat', displayName: 'Pat', password: 'pat password 12', role: 'user' });
  const pat = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'pat', password: 'pat password 12' } }));
  assert.equal((await req('GET', `/api/v1/exercises/${bench}`, undefined, pat)).json().exercise.cues, null);

  // Empty clears them; unknown exercises are refused.
  assert.equal((await req('PUT', `/api/v1/exercises/${bench}/cues`, { cues: '   ' })).json().exercise.cues, null);
  assert.equal((await req('PUT', '/api/v1/exercises/lib:Nope/cues', { cues: 'x' })).statusCode, 404);
  assert.equal((await req('PUT', `/api/v1/exercises/${bench}/cues`, { cues: 'x'.repeat(2001) })).statusCode, 400);
});

test('cues sent on a workout step move to the exercise', async () => {
  await req('PUT', `/api/v1/exercises/${bench}/cues`, { cues: 'Elbows at 45°' });
  const res = await req('POST', '/api/v1/workouts', {
    name: 'Push',
    icon: '',
    items: [step(bench, 's1', 'Pause at the bottom'), { kind: 'superset', id: 'ss', label: 'Again', rounds: 2, items: [step(bench, 's2', 'Elbows at 45°')] }],
  });
  assert.equal(res.statusCode, 201, res.body);
  const { workout, exercises } = (await req('GET', `/api/v1/workouts/${res.json().workout.id}`)).json();
  assert.equal(workout.items[0].notes, null);
  assert.equal(workout.items[1].items[0].notes, null);
  assert.equal(exercises[bench].cues, 'Elbows at 45°\nPause at the bottom', 'added once, nothing repeated');
});

test('the update moves cues from workout steps to their exercises', async () => {
  const w = (await req('POST', '/api/v1/workouts', { name: 'Push', icon: '', items: [step(bench, 's1')] })).json().workout;
  const w2 = (await req('POST', '/api/v1/workouts', { name: 'Push B', icon: '', items: [step(bench, 's1'), step('lib:Plank', 's2')] })).json().workout;
  // Put cues back on the steps the way an older database had them.
  const set = db.prepare("UPDATE workout_items SET data = json_set(data, '$.notes', ?) WHERE workout_id = ? AND id = ?");
  set.run('Elbows in', w.id, 's1');
  set.run('Pause at the bottom', w2.id, 's1');
  set.run('Squeeze glutes', w2.id, 's2');
  db.exec('DELETE FROM exercise_cues');
  migrations.find((m) => m.version === 8)!.run!(db);

  const ex = (id: string) => (req('GET', `/api/v1/exercises/${id}`)).then((r) => r.json().exercise.cues);
  assert.equal(await ex(bench), 'Elbows in\nPause at the bottom', 'different cues from different workouts are joined');
  assert.equal(await ex('lib:Plank'), 'Squeeze glutes');
  const notes = (db.prepare("SELECT json_extract(data, '$.notes') AS n FROM workout_items WHERE kind = 'exercise'").all() as { n: string | null }[]).map((r) => r.n);
  assert.ok(notes.every((n) => n === null), 'steps keep no cues');
});
