# setryx

A self-hosted workout tracker for one household or a group of friends. It runs as a single Docker container serving plain HTTP. If you want HTTPS, put your own reverse proxy in front.

What it does:

- **Workouts:** build them from a library of 876 exercises plus your own, with sets, reps, weights, timed holds, rests and supersets.
- **Player:** a full-screen guide through the workout, with timers, sounds and voice cues. It keeps the screen on and picks up where you left off after a reload.
- **Review:** check what you did after each workout. setryx suggests new targets and updates the workout if you agree.
- **Offline:** finish a workout with no connection; it uploads when the server is reachable again.
- **Routines:** a rotation (Push A, Pull A, …), a one-off programme, or a weekly plan. Today shows what's up next.
- **Stats:** a streak, a calendar, sessions per week, and charts and records for each exercise.
- **Accounts:** everyone has their own data; an admin adds people or sends invite links.

Status: working towards v1.0. Everything above works; the remaining work before v1.0 is behind the scenes, not in the app's screens.

## Run it

```bash
cp stack.env.example stack.env   # optional: add SESSION_SECRET
docker compose up -d --build
```

Open `http://<your-server>:38471`. The first account you create becomes the admin. Sign-up then closes. To add people, go to **Settings → People and invites**, then either create accounts yourself or send invite links.

Data lives in the `setryx-data` volume (`/data` in the container): the SQLite database, the generated session secret, database copies (`backups/`) and exercise photos if you turn them on (`exercise-images/`).

### Update

```bash
git pull
```

```bash
docker compose up -d --build
```

If an update changes the database, setryx first saves a copy of it as it was (see [Backups](#backups)).

The exercise library comes from [free-exercise-db](https://github.com/yuhonas/free-exercise-db) (public domain).

### Exercise photos (optional)

Photos are off by default, and setryx contacts nothing outside your network until an admin turns them on under **Settings → Exercise photos**. Once on, each photo is downloaded from GitHub the first time someone opens that exercise. Or use **Download all** to fetch every photo up front (about 100 MB). They're kept in `/data/exercise-images`, and **Remove downloaded photos** deletes them again. Your own exercises have no photos.

### Configuration

| Variable | Where | Default | What it does |
|---|---|---|---|
| `PORT` | compose | `38471` | Port the server listens on |
| `TRUST_PROXY` | compose | `false` | Set `true` behind a reverse proxy, so HTTPS and client IPs are detected |
| `COOKIE_SECURE` | compose | `auto` | `auto` marks cookies Secure when the proxy reports HTTPS; or `true` / `false` |
| `BASE_URL` | compose | (unset) | Public address used in invite links, e.g. `https://setryx.example.com` |
| `SESSION_SECRET` | `stack.env` | generated | Signs session cookies; at least 32 characters |

Secrets go only in `stack.env`, which git ignores.

### HTTPS (optional)

setryx works over plain HTTP, including finishing a workout with no connection: sessions are kept on the phone and upload when the server is reachable again. With HTTPS, phones can also install setryx as an app, open it with no connection at all, and use the browser's own keep-screen-on feature. Two example proxies:

Caddy:
```
setryx.example.com {
  reverse_proxy setryx:38471
}
```

Traefik labels:
```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.setryx.rule=Host(`setryx.example.com`)
  - traefik.http.routers.setryx.tls.certresolver=letsencrypt
  - traefik.http.services.setryx.loadbalancer.server.port=38471
```
Set `TRUST_PROXY: "true"` and `BASE_URL` when using a proxy.

### Backups

Everything lives in the `/data` volume, so backing up that volume backs up setryx. A few things make that safe:

- The database file, `setryx.db`, always holds every saved change on its own; there's no side file to copy along.
- setryx also keeps complete copies in `/data/backups` that are always written in one go, so a backup tool can never catch one half-written:
  - `setryx-latest.db`, refreshed every 15 minutes when something changed, and when the container stops;
  - `setryx-before-v<N>-<time>.db`, taken just before an update changes the database (the last 3 are kept).
- An admin can change the folder, how many copies are kept and how often the up-to-date copy refreshes under **Settings → Backups**, and make a copy by hand. To keep copies outside the data volume, mount another volume and point the folder at it.

Exercise photos (`/data/exercise-images`) aren't in the copies; they can always be downloaded again.

To restore a copy:

```bash
docker compose stop setryx
docker compose run --rm --no-deps --entrypoint sh setryx -c 'cp /data/backups/setryx-latest.db /data/setryx.db && rm -f /data/setryx.db-wal /data/setryx.db-shm /data/setryx.db-journal'
docker compose start setryx
```

Replace `setryx-latest.db` with whichever copy you want. Run these from the folder with your `docker-compose.yml`.

### Locked out?

```bash
docker exec -it setryx list-users
```

```bash
docker exec -it setryx reset-password <username>
```

This also turns the account back on and signs it out everywhere.

## Develop

Needs Node 24.7 or newer. TypeScript runs directly in Node, with no build step for the server.

```bash
npm install
```

```bash
npm run dev
```

The API runs on :38471 and Vite on :5173 (it proxies `/api`). Other commands: `npm test` runs the shared logic and API tests, `npm run typecheck` checks types, and `npm run build` builds the web app into `apps/web/dist`, which the server serves.

Layout: `apps/server` (Fastify + built-in `node:sqlite`), `apps/web` (React + Vite, installable as an app), `packages/shared` (schemas and the logic used by both: the workout player, routines and stats), `e2e` (the browser test).

### End-to-end test

A full workout (first-run setup, playing a workout, the review, saving, Stats) runs in a real browser, entirely in containers: a throwaway setryx built from the current code with an empty database, and Microsoft's Playwright image with Chromium. Nothing is installed on your machine.

```bash
sh e2e/run.sh
```

It starts from an empty database every time and removes the test copy of setryx when it's done. The Playwright image is a large one-off download (Docker lists it at about 3.5 GB); remove it with `docker rmi mcr.microsoft.com/playwright:v1.55.0-noble` when you no longer need it.
