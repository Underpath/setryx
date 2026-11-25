import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { purgeExpiredSessions } from './sessions.ts';

const config = loadConfig();
const db = openDb(config.dataDir);
const app = await buildApp(config, db, { logger: true });

purgeExpiredSessions(db);
const purgeTimer = setInterval(() => purgeExpiredSessions(db), 6 * 3_600_000);
purgeTimer.unref();

if (!config.webDist) app.log.warn('No built web app found; serving the API only. Run `npm run build` first.');

await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    db.close();
    process.exit(0);
  });
}
