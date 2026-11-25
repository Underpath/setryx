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

const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: object, as = cookie) =>
  app.inject({ method, url, payload: body, headers: as ? { cookie: as } : {} });

function cookieOf(res: LightMyRequestResponse): string {
  const c = res.cookies.find((c) => c.name === 'setryx_session');
  assert.ok(c);
  return `setryx_session=${c.value}`;
}

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'setryx-test-'));
  app = await buildApp(loadConfig({ DATA_DIR: dataDir, WEB_DIST: join(dataDir, 'none') }), openDb(':memory:'));
  const res = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', displayName: 'Owner', password: 'owner password 1' } });
  cookie = cookieOf(res);
});

async function libraryId(q: string): Promise<string> {
  const res = (await req('GET', `/api/v1/exercises?q=${encodeURIComponent(q)}`)).json();
  assert.ok(res.exercises.length, `expected library hits for ${q}`);
  return res.exercises[0].id;
}

const step = (exerciseId: string, id: string) => ({
  kind: 'exercise', id, exerciseId, targetType: 'reps', targetReps: 10, targetDurationS: null, targetWeight: 8,
  tempo: '3-1-1-0', rir: '2', notes: null, equipmentNote: null,
});

test('the library is seeded and searchable', async () => {
  const all = (await req('GET', '/api/v1/exercises?limit=1')).json();
  assert.ok(all.total > 800, `seeded ${all.total}`);
  const hits = (await req('GET', '/api/v1/exercises?q=dead%20bug')).json();
  assert.equal(hits.exercises[0].name, 'Dead Bug');
  const facets = (await req('GET', '/api/v1/exercises/facets')).json();
  assert.ok(facets.muscles.includes('chest') && facets.equipment.includes('dumbbell'));
  assert.equal((await req('GET', '/api/v1/exercises', undefined, '')).statusCode, 401);
});

test('custom exercises are private and editable; library ones are not', async () => {
  const created = await req('POST', '/api/v1/exercises', { name: 'Bird dog', equipment: ['Mat'] });
  assert.equal(created.statusCode, 201);
  const id = created.json().exercise.id;
  assert.equal(created.json().exercise.isCustom, true);
  const mine = (await req('GET', '/api/v1/exercises?custom=1')).json();
  assert.deepEqual(mine.exercises.map((e: { name: string }) => e.name), ['Bird dog']);

  const edit = await req('PUT', `/api/v1/exercises/${id}`, { name: 'Bird dog (slow)', defaultType: 'reps' });
  assert.equal(edit.json().exercise.name, 'Bird dog (slow)');
  const lib = await libraryId('dead bug');
  assert.equal((await req('PUT', `/api/v1/exercises/${lib}`, { name: 'Hacked' })).statusCode, 404);

  // Another user can't see it.
  await req('POST', '/api/v1/admin/users', { username: 'other', displayName: 'Other', password: 'other password 1' });
  const other = cookieOf(await req('POST', '/api/v1/auth/login', { username: 'other', password: 'other password 1' }, ''));
  assert.equal((await req('GET', `/api/v1/exercises/${id}`, undefined, other)).statusCode, 404);
});

test('create, read, replace, duplicate and delete a workout', async () => {
  const press = await libraryId('incline dumbbell press');
  const body = {
    name: 'Push A',
    icon: '🫷',
    items: [{ kind: 'superset', id: 'ss1', label: 'Chest', rounds: 3, items: [step(press, 'a'), { kind: 'rest', id: 'r', durationS: 20, label: null }] }],
  };
  const created = await req('POST', '/api/v1/workouts', body);
  assert.equal(created.statusCode, 201, created.body);
  const { workout, exercises } = created.json();
  assert.equal(workout.items[0].items[0].targetWeight, 8);
  assert.ok(exercises[press], 'response includes the exercises it uses');

  const list = (await req('GET', '/api/v1/workouts')).json().workouts;
  assert.equal(list[0].stepCount, 5, '3 rounds × 2 steps, minus the trailing rest');
  assert.equal(list[0].supersetCount, 1);

  const replaced = await req('PUT', `/api/v1/workouts/${workout.id}`, { ...body, name: 'Push A2', items: [step(press, 'b')] });
  assert.equal(replaced.json().workout.name, 'Push A2');
  assert.equal(replaced.json().workout.items.length, 1);

  const dup = await req('POST', `/api/v1/workouts/${workout.id}/duplicate`);
  assert.equal(dup.json().workout.name, 'Push A2 (copy)');
  assert.notEqual(dup.json().workout.items[0].id, 'b', 'copies get new step ids');

  assert.equal((await req('DELETE', `/api/v1/workouts/${workout.id}`)).statusCode, 204);
  assert.equal((await req('GET', `/api/v1/workouts/${workout.id}`)).statusCode, 404);
});

test('workout validation: empty, unknown exercise, duplicate ids', async () => {
  const press = await libraryId('incline dumbbell press');
  const empty = await req('POST', '/api/v1/workouts', { name: 'x', items: [{ kind: 'rest', id: 'r', durationS: 10, label: null }] });
  assert.equal(empty.statusCode, 400);
  const unknown = await req('POST', '/api/v1/workouts', { name: 'x', items: [step('nope', 'a')] });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().error, 'unknown_exercise');
  const dupIds = await req('POST', '/api/v1/workouts', { name: 'x', items: [step(press, 'a'), step(press, 'a')] });
  assert.equal(dupIds.statusCode, 400);
  const noReps = await req('POST', '/api/v1/workouts', { name: 'x', items: [{ ...step(press, 'a'), targetReps: null }] });
  assert.equal(noReps.statusCode, 400);
});

const routinesFile = {
  version: 1,
  routines: [
    {
      name: 'Push A',
      icon: '🫷',
      exercises: [
        {
          kind: 'superset', name: 'Core', rounds: 2,
          exercises: [
            { name: 'Dead bug', desc: 'Bodyweight.', type: 'reps', reps: 8, equipment: 'Bodyweight' },
            { name: 'Rest', desc: '', type: 'timed', duration: 15 },
            { name: 'Dumbbell fly (incline bench)', desc: 'Weight: 5 kg per hand. Soft elbows.', type: 'reps', reps: 11, equipment: 'Dumbbells 5 kg, Incline bench' },
            { name: 'Rest', desc: '', type: 'timed', duration: 45 },
          ],
        },
      ],
    },
  ],
};

test('routine import: preview suggests matches, import creates workouts and custom exercises', async () => {
  const preview = await req('POST', '/api/v1/import/routines/preview', { data: routinesFile });
  assert.equal(preview.statusCode, 200, preview.body);
  const p = preview.json();
  assert.equal(p.workouts[0].name, 'Push A');
  const bug = p.exercises.find((e: { name: string }) => e.name === 'Dead bug');
  const fly = p.exercises.find((e: { name: string }) => e.name.startsWith('Dumbbell fly'));
  assert.equal(bug.defaultChoice.type, 'library', 'identical names link to the library');
  assert.equal(fly.defaultChoice.type, 'custom', 'specific names stay your own');
  assert.ok(fly.suggestions.length > 0);
  assert.deepEqual(fly.weights, [5]);

  const choices = Object.fromEntries(p.exercises.map((e: { key: string; defaultChoice: unknown }) => [e.key, e.defaultChoice]));
  const done = await req('POST', '/api/v1/import/routines', { data: routinesFile, choices });
  assert.equal(done.statusCode, 201, done.body);
  const id = done.json().workouts[0].id;
  const { workout, exercises } = (await req('GET', `/api/v1/workouts/${id}`)).json();
  const ss = workout.items[0];
  assert.equal(ss.rounds, 2);
  assert.deepEqual(ss.items.map((s: { kind: string }) => s.kind), ['exercise', 'rest', 'exercise', 'rest']);
  assert.equal(ss.items[2].targetWeight, 5);
  assert.equal(exercises[ss.items[2].exerciseId].name, 'Dumbbell fly (incline bench)');
  assert.equal(exercises[ss.items[2].exerciseId].isCustom, true);
  assert.equal(exercises[ss.items[0].exerciseId].isCustom, false);

  // Importing again reuses the custom exercise instead of making a duplicate.
  const again = (await req('POST', '/api/v1/import/routines/preview', { data: routinesFile })).json();
  const fly2 = again.exercises.find((e: { name: string }) => e.name.startsWith('Dumbbell fly'));
  assert.equal(fly2.defaultChoice.type, 'existing');
  assert.equal(again.workouts[0].existingName, true);
});

test('routine import rejects unreadable files', async () => {
  const res = await req('POST', '/api/v1/import/routines/preview', { data: { hello: 'world' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'unreadable_file');
});

test('export includes workouts and custom exercises', async () => {
  const press = await libraryId('incline dumbbell press');
  const custom = (await req('POST', '/api/v1/exercises', { name: 'Bird dog' })).json().exercise;
  await req('POST', '/api/v1/workouts', { name: 'A', items: [step(press, 'a'), step(custom.id, 'b')] });
  const res = await req('GET', '/api/v1/export');
  assert.match(String(res.headers['content-disposition']), /attachment; filename="setryx-export-/);
  const body = res.json();
  assert.equal(body.app, 'setryx');
  assert.equal(body.workouts.length, 1);
  assert.deepEqual(body.exercises.map((e: { name: string }) => e.name), ['Bird dog']);
  assert.equal(body.libraryExercises[0].id, press);
});
