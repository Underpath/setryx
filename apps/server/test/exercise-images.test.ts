import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fetchImage, moveOldImages } from '../src/exercise-images.ts';

// A stand-in for the photo source that misbehaves in each way it could.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
let server: Server;
let source: string;

before(async () => {
  server = createServer((req, res) => {
    const dir = req.url!.split('/')[1];
    if (dir === 'ok') return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPEG);
    if (dir === 'redirect') return res.writeHead(302, { location: '/ok/0.jpg' }).end();
    if (dir === 'html') return res.writeHead(200, { 'content-type': 'image/jpeg' }).end('<html><script>alert(1)</script></html>');
    if (dir === 'declared-big') return res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '5000000' }).end();
    if (dir === 'endless') {
      // No length given; keeps sending until the client hangs up.
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      const chunk = Buffer.concat([JPEG, Buffer.alloc(64 * 1024)]);
      const send = () => {
        while (res.write(chunk)) if (res.destroyed) return;
        res.once('drain', send);
      };
      res.on('close', () => res.removeAllListeners('drain'));
      return send();
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  source = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
after(() => server.close());

const fresh = () => mkdtempSync(join(tmpdir(), 'setryx-img-'));

test('a JPEG is downloaded and saved', async () => {
  const dir = fresh();
  assert.equal(await fetchImage(dir, 'ok/0.jpg', source), true);
  assert.ok(existsSync(join(dir, 'ok/0.jpg')));
});

test('redirects, non-JPEGs and oversized photos are refused and nothing is saved', async () => {
  const dir = fresh();
  for (const path of ['redirect/0.jpg', 'html/0.jpg', 'declared-big/0.jpg', 'endless/0.jpg']) {
    const t0 = Date.now();
    assert.equal(await fetchImage(dir, path, source), false, path);
    assert.ok(Date.now() - t0 < 5000, `${path} took ${Date.now() - t0} ms`);
    assert.ok(!existsSync(join(dir, path)), path);
  }
});

test('photos in the old place inside the data folder move to the photo folder once', () => {
  const data = fresh();
  const images = fresh();
  mkdirSync(join(data, 'exercise-images/Squat'), { recursive: true });
  writeFileSync(join(data, 'exercise-images/Squat/0.jpg'), JPEG);
  const logs: string[] = [];
  moveOldImages(data, images, (m) => logs.push(m));
  assert.ok(existsSync(join(images, 'Squat/0.jpg')));
  assert.ok(!existsSync(join(data, 'exercise-images')));
  assert.equal(logs.length, 1);
  moveOldImages(data, images, (m) => logs.push(m));
  assert.equal(logs.length, 1, 'nothing to do the second time');
  // Without a separate folder, the old place is the photo folder: nothing moves.
  moveOldImages(images, join(images, 'exercise-images'), (m) => logs.push(m));
  assert.equal(logs.length, 1);
});
