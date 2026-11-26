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
let pressId: string;

const req = (method: 'GET' | 'PUT', url: string, body?: object) => app.inject({ method, url, payload: body, headers: { cookie } });
const cookieOf = (res: LightMyRequestResponse) => `setryx_session=${res.cookies.find((c) => c.name === 'setryx_session')!.value}`;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'setryx-test-'));
  app = await buildApp(loadConfig({ DATA_DIR: dir, WEB_DIST: join(dir, 'none') }), openDb(':memory:'));
  cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', displayName: 'Owner', password: 'owner password 1' } }));
  pressId = (await req('GET', '/api/v1/exercises?q=incline%20dumbbell%20press')).json().exercises[0].id;
});

const DAY = 86_400_000;
const save = (n: number, startedAt: number, sets: [number, number | null][]) =>
  req('PUT', `/api/v1/sessions/00000000-0000-4000-8000-00000000000${n}`, {
    workoutId: null, workoutName: 'Push', startedAt, endedAt: startedAt + 3_000_000, durationMs: 3_000_000, status: 'completed',
    items: [], exercises: { [pressId]: { name: 'Incline press', equipment: [], instructions: [] } },
    logs: sets.map(([reps, weight], i) => ({
      stepIndex: i, itemId: 'p', exerciseId: pressId, round: i + 1, plannedReps: 10, actualReps: reps, plannedWeight: weight, actualWeight: weight,
      plannedDurationS: null, actualDurationS: null, completedAt: startedAt + i * 60_000,
    })),
  });

test('session points, exercise list, history and bests', async () => {
  const t = Date.now();
  await save(1, t - 14 * DAY, [[10, 20], [8, 20]]);
  await save(2, t - 7 * DAY, [[8, 22.5]]);
  await save(3, t - DAY, [[10, 22.5]]);

  const pts = (await req('GET', '/api/v1/stats/sessions?days=30')).json().sessions;
  assert.equal(pts.length, 3);
  assert.equal(pts[0].durationMs, 3_000_000);
  assert.equal((await req('GET', '/api/v1/stats/sessions?days=3')).json().sessions.length, 1);

  const list = (await req('GET', '/api/v1/stats/exercises')).json().exercises;
  assert.equal(list.length, 1);
  assert.equal(list[0].sessions, 3);
  assert.equal(list[0].bests.weight, 22.5);
  assert.equal(list[0].bests.e1rm, 30);
  assert.ok(list[0].name.length > 0);

  const h = (await req('GET', `/api/v1/stats/exercises/${pressId}`)).json();
  assert.deepEqual(h.entries.map((e: { sets: unknown[] }) => e.sets.length), [2, 1, 1], 'oldest first');
  assert.equal((await req('GET', '/api/v1/stats/exercises/nope')).statusCode, 404);

  const b = (await req('GET', `/api/v1/stats/bests?ids=${pressId},other&exclude=00000000-0000-4000-8000-000000000003`)).json().bests;
  assert.equal(b[pressId].weight, 22.5);
  assert.equal(b[pressId].e1rm, 28.5, 'the excluded session’s 10 × 22.5 doesn’t count');
  assert.equal(b.other.weight, null);
});
