import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';

let app: FastifyInstance;
let cookie: string;
let dir: string;
let fetched: string[];
const realFetch = globalThis.fetch;

const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: object) => app.inject({ method, url, payload: body, headers: { cookie } });
const cookieOf = (res: LightMyRequestResponse) => `setryx_session=${res.cookies.find((c) => c.name === 'setryx_session')!.value}`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'setryx-test-'));
  app = await buildApp(loadConfig({ DATA_DIR: dir, WEB_DIST: join(dir, 'none') }), openDb(':memory:'));
  cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', displayName: 'Owner', password: 'owner password 1' } }));
  fetched = [];
  // Stand-in for GitHub: every photo is a tiny JPEG.
  globalThis.fetch = (async (url: string | URL) => {
    fetched.push(String(url));
    return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('photos are off until an admin allows them, then fetched on first view', async () => {
  assert.equal((await req('GET', '/api/v1/exercise-images/Barbell_Squat/0.jpg')).statusCode, 404);
  assert.equal(fetched.length, 0, 'nothing leaves the server while off');

  const st = (await req('GET', '/api/v1/admin/exercise-images')).json();
  assert.equal(st.allowed, false);
  assert.ok(st.total > 1000);
  assert.ok(st.estimatedTotalBytes > 50_000_000, 'estimate from the sample average');

  assert.equal((await req('PATCH', '/api/v1/admin/exercise-images', { allowed: true })).json().allowed, true);
  const res = await req('GET', '/api/v1/exercise-images/Barbell_Squat/0.jpg');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal(fetched.length, 1);
  assert.ok(fetched[0]!.endsWith('/exercises/Barbell_Squat/0.jpg'));
  assert.ok(existsSync(join(dir, 'exercise-images/Barbell_Squat/0.jpg')));
  // Second view comes from disk.
  await req('GET', '/api/v1/exercise-images/Barbell_Squat/0.jpg');
  assert.equal(fetched.length, 1);
  // Only photos the library refers to.
  assert.equal((await req('GET', '/api/v1/exercise-images/Not_An_Exercise/0.jpg')).statusCode, 404);
  assert.equal(fetched.length, 1);

  assert.equal((await req('GET', '/api/v1/admin/exercise-images')).json().downloaded, 1);
  // Turning it off hides them again.
  await req('PATCH', '/api/v1/admin/exercise-images', { allowed: false });
  assert.equal((await req('GET', '/api/v1/exercise-images/Barbell_Squat/0.jpg')).statusCode, 404);
});

test('download all, then remove', async () => {
  assert.equal((await req('POST', '/api/v1/admin/exercise-images/download')).statusCode, 409, 'needs allowing first');
  await req('PATCH', '/api/v1/admin/exercise-images', { allowed: true });
  const started = (await req('POST', '/api/v1/admin/exercise-images/download')).json();
  assert.equal(started.job.running, true);
  let st = started;
  for (let i = 0; i < 200 && st.job.running; i++) {
    await new Promise((r) => setTimeout(r, 50));
    st = (await req('GET', '/api/v1/admin/exercise-images')).json();
  }
  assert.equal(st.job.running, false);
  assert.equal(st.downloaded, st.total, JSON.stringify(st));
  assert.equal(st.job.failed, 0);

  const gone = (await req('DELETE', '/api/v1/admin/exercise-images')).json();
  assert.equal(gone.downloaded, 0);
  assert.equal(existsSync(join(dir, 'exercise-images')), false);
});
