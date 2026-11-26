import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DB } from './db.ts';

// Exercise photos from the free-exercise-db project (public domain), kept in
// /data/exercise-images. Off by default: nothing is fetched until an admin
// allows it. When allowed, a photo is downloaded the first time someone opens
// that exercise, or all at once with the admin's "Download all".

export const IMAGE_SOURCE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/';
/** Average photo size, measured on a sample; used until real ones are on disk. */
const SAMPLE_AVG_BYTES = 55_960;
const MAX_BYTES = 3_000_000;
const PATH_RE = /^[A-Za-z0-9_()'.,-]{1,120}\/\d{1,2}\.jpg$/;

export const imagesDir = (dataDir: string) => join(dataDir, 'exercise-images');

export function imagesAllowed(db: DB): boolean {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'exercise_images'").get() as { value: string } | undefined;
  return row?.value === 'true';
}

export function setImagesAllowed(db: DB, allowed: boolean): void {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('exercise_images', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(allowed));
  if (!allowed) job.cancelled = true;
}

/** Every photo the library refers to (seeded exercises only). */
export function knownImages(db: DB): string[] {
  const rows = db.prepare("SELECT images FROM exercises WHERE source = 'free-exercise-db' AND archived = 0").all() as { images: string }[];
  const out = new Set<string>();
  for (const r of rows) for (const p of JSON.parse(r.images) as string[]) if (PATH_RE.test(p) && !p.includes('..')) out.add(p);
  return [...out];
}

let known: Set<string> | null = null;
/** Only photos the library actually refers to are ever fetched. */
export function isKnownImage(db: DB, path: string): boolean {
  known ??= new Set(knownImages(db));
  return known.has(path);
}

export const isValidPath = (p: string) => PATH_RE.test(p) && !p.includes('..');

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

const inFlight = new Map<string, Promise<boolean>>();

/** Downloads one photo into the data folder. True when it's there afterwards. */
export function fetchImage(dataDir: string, path: string): Promise<boolean> {
  const pending = inFlight.get(path);
  if (pending) return pending;
  const p = (async () => {
    const file = join(imagesDir(dataDir), path);
    if (await exists(file)) return true;
    const res = await fetch(IMAGE_SOURCE + path.split('/').map(encodeURIComponent).join('/'), { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return false;
    await mkdir(join(file, '..'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, buf);
    await rename(tmp, file);
    return true;
  })()
    .catch(() => false)
    .finally(() => inFlight.delete(path));
  inFlight.set(path, p);
  return p;
}

// ── Download all ──

type Job = { running: boolean; cancelled: boolean; total: number; done: number; failed: number; finishedAt: string | null };
const job: Job = { running: false, cancelled: false, total: 0, done: 0, failed: 0, finishedAt: null };

export function startDownloadAll(db: DB, dataDir: string): void {
  if (job.running) return;
  const paths = knownImages(db);
  Object.assign(job, { running: true, cancelled: false, total: paths.length, done: 0, failed: 0, finishedAt: null });
  let next = 0;
  const worker = async () => {
    while (!job.cancelled && next < paths.length) {
      const p = paths[next++]!;
      if (await fetchImage(dataDir, p)) job.done++;
      else job.failed++;
    }
  };
  // A few at a time: quick, without hammering GitHub or a small server's disk.
  void Promise.all(Array.from({ length: 4 }, worker)).finally(() => {
    job.running = false;
    job.finishedAt = new Date().toISOString();
  });
}

async function onDisk(dataDir: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  let dirs: string[] = [];
  try {
    dirs = await readdir(imagesDir(dataDir));
  } catch {
    return { count, bytes };
  }
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = await readdir(join(imagesDir(dataDir), d));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jpg')) continue;
      try {
        bytes += (await stat(join(imagesDir(dataDir), d, f))).size;
        count++;
      } catch {
        /* removed meanwhile */
      }
    }
  }
  return { count, bytes };
}

export type ImagesStatus = {
  allowed: boolean;
  total: number;
  downloaded: number;
  bytes: number;
  /** Size of all photos: from real ones once there are enough, else from a sample. */
  estimatedTotalBytes: number;
  job: { running: boolean; total: number; done: number; failed: number; finishedAt: string | null };
};

export async function imagesStatus(db: DB, dataDir: string): Promise<ImagesStatus> {
  const total = knownImages(db).length;
  // Job state first: if it says finished, the count that follows includes every file it wrote.
  const jobNow = { running: job.running, total: job.total, done: job.done, failed: job.failed, finishedAt: job.finishedAt };
  const disk = await onDisk(dataDir);
  const avg = disk.count >= 20 ? disk.bytes / disk.count : SAMPLE_AVG_BYTES;
  return {
    allowed: imagesAllowed(db),
    total,
    downloaded: disk.count,
    bytes: disk.bytes,
    estimatedTotalBytes: Math.round(avg * total),
    job: jobNow,
  };
}

export async function removeAllImages(dataDir: string): Promise<void> {
  job.cancelled = true;
  await rm(imagesDir(dataDir), { recursive: true, force: true });
}
