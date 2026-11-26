import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { migrations } from '../src/migrations.ts';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { LATEST, Backups, backupBeforeUpdate } from '../src/backup.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const backupsDir = (dir: string) => join(dir, 'backups');

const fresh = () => mkdtempSync(join(tmpdir(), 'setryx-backup-'));
const version = (file: string) => {
  const d = new DatabaseSync(file, { readOnly: true });
  const v = (d.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
  d.close();
  return v;
};

test('an update to an existing database keeps a copy from before', () => {
  const dir = fresh();
  // A database from an older release: only the first migrations applied, with a user in it.
  const old = new DatabaseSync(join(dir, 'setryx.db'));
  old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of migrations.slice(0, 2)) {
    old.exec(m.sql);
    old.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(m.version, 'then');
  }
  old.prepare("INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES ('u', 'me', 'Me', 'x', 'admin', 'then', 'then')").run();
  old.close();

  const db = openDb(dir);
  const backups = readdirSync(backupsDir(dir)).filter((f) => f.startsWith('setryx-before-'));
  assert.equal(backups.length, 1);
  assert.match(backups[0]!, new RegExp(`^setryx-before-v${migrations.at(-1)!.version}-`));
  assert.equal(version(join(backupsDir(dir), backups[0]!)), 2, 'the copy is the database before the update');
  assert.equal(version(join(dir, 'setryx.db')), migrations.at(-1)!.version);
  db.close();

  // Opening again with nothing to update takes no new copy.
  openDb(dir).close();
  assert.equal(readdirSync(backupsDir(dir)).filter((f) => f.startsWith('setryx-before-')).length, 1);
});

test('a brand-new database takes no update copy, and only the last three are kept by default', () => {
  const dir = fresh();
  const db = openDb(dir);
  assert.equal(existsSync(backupsDir(dir)), false);
  mkdirSync(backupsDir(dir));
  for (let i = 0; i < 6; i++) writeFileSync(join(backupsDir(dir), `setryx-before-v3-2026-01-0${i + 1}T00-00-00-000Z.db`), 'old');
  backupBeforeUpdate(db, dir, 9);
  const left = readdirSync(backupsDir(dir)).filter((f) => f.startsWith('setryx-before-')).sort();
  assert.equal(left.length, 3);
  assert.ok(!left.includes('setryx-before-v3-2026-01-01T00-00-00-000Z.db'), 'the oldest go first');
  assert.ok(left.some((f) => f.startsWith('setryx-before-v9-')));
  db.close();
});

test('the latest copy is complete and refreshed only when something changed', () => {
  const dir = fresh();
  const db = openDb(dir);
  // The live file holds everything on its own (no side file to copy along).
  assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete');
  assert.equal(existsSync(join(dir, 'setryx.db-wal')), false);

  const copy = new Backups(db, dir);
  copy.start();
  const file = join(backupsDir(dir), LATEST);
  assert.ok(existsSync(file));
  const first = statSync(file).mtimeMs;
  copy.flush();
  assert.equal(statSync(file).mtimeMs, first, 'nothing changed, no new copy');
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('x', 'y')").run();
  copy.flush();
  const d = new DatabaseSync(file, { readOnly: true });
  assert.equal((d.prepare("SELECT value FROM app_settings WHERE key = 'x'").get() as { value: string }).value, 'y');
  d.close();
  assert.equal(readdirSync(backupsDir(dir)).some((f) => f.endsWith('.tmp')), false);
  copy.stop();
  db.close();
});

test('admin backup settings: folder, how many to keep, the up-to-date copy, copy now', async () => {
  const dir = fresh();
  const app: FastifyInstance = await buildApp(loadConfig({ DATA_DIR: dir, WEB_DIST: join(dir, 'none') }), openDb(dir));
  const cookieOf = (res: LightMyRequestResponse) => `setryx_session=${res.cookies.find((c) => c.name === 'setryx_session')!.value}`;
  const cookie = cookieOf(await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'owner', displayName: 'Owner', password: 'owner password 1' } }));
  const req = (method: 'GET' | 'PUT' | 'POST', url: string, body?: object) => app.inject({ method, url, payload: body, headers: { cookie } });

  const first = (await req('GET', '/api/v1/admin/backups')).json();
  assert.deepEqual(first.settings, { dir: join(dir, 'backups'), keep: 3, latestEveryMinutes: 15 });

  // Copy now, three times with keep 2: the oldest manual copy goes.
  const other = join(dir, 'elsewhere');
  const saved = await req('PUT', '/api/v1/admin/backups', { dir: other, keep: 2, latestEveryMinutes: 0 });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().settings.dir, other);
  for (let i = 0; i < 3; i++) {
    assert.equal((await req('POST', '/api/v1/admin/backups/now')).statusCode, 200);
    await new Promise((r) => setTimeout(r, 5));
  }
  const files = (await req('GET', '/api/v1/admin/backups')).json().files;
  assert.equal(files.filter((f: { kind: string }) => f.kind === 'manual').length, 2);
  assert.equal(files.some((f: { kind: string }) => f.kind === 'latest'), false, 'the up-to-date copy is off');

  // Bad folders are refused with a reason.
  assert.equal((await req('PUT', '/api/v1/admin/backups', { dir: 'relative/path', keep: 3, latestEveryMinutes: 15 })).statusCode, 400);
  const blocked = join(dir, 'a-file');
  writeFileSync(blocked, 'not a folder');
  const res = await req('PUT', '/api/v1/admin/backups', { dir: join(blocked, 'inside'), keep: 3, latestEveryMinutes: 15 });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /can’t write/);

  // Turning the up-to-date copy back on writes it straight away.
  await req('PUT', '/api/v1/admin/backups', { dir: other, keep: 2, latestEveryMinutes: 15 });
  assert.ok(existsSync(join(other, LATEST)));
  app.backups.stop();
  await app.close();
});
