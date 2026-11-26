import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { purgeExpiredSessions } from './sessions.ts';
import { purgeOldDevices } from './devices.ts';
import { moveOldImages } from './exercise-images.ts';

const config = loadConfig();
const db = openDb(config.dataDir);
const app = await buildApp(config, db, { logger: true });

purgeExpiredSessions(db);
purgeOldDevices(db);
moveOldImages(config.dataDir, config.imagesDir, (msg) => app.log.info(msg));
// setryx-latest.db: a complete copy for volume backups, refreshed when something changed.
app.backups.start();
const purgeTimer = setInterval(() => (purgeExpiredSessions(db), purgeOldDevices(db)), 6 * 3_600_000);
purgeTimer.unref();

if (!config.allowedHosts) {
  app.log.warn('Neither BASE_URL nor ALLOWED_HOSTS is set, so any host name is accepted. Set one to block DNS-rebinding pages.');
}
if (config.baseUrl?.startsWith('https://') && config.cookieSecure === 'false') {
  app.log.warn('BASE_URL is https:// but COOKIE_SECURE=false, so the session cookie is sent without Secure.');
}
if (!config.webDist) app.log.warn('No built web app found; serving the API only. Run `npm run build` first.');

await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    try {
      app.backups.flush();
    } catch (err) {
      app.log.error(err, 'Could not refresh the latest backup copy');
    }
    app.backups.stop();
    db.close();
    process.exit(0);
  });
}
