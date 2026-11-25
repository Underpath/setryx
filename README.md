# setryx

A self-hosted workout tracker for one household or a group of friends. It runs as a single Docker container serving plain HTTP. If you want HTTPS, put your own reverse proxy in front.

Status: early development. Accounts, the exercise library, workout building, routine import and the workout player work; reviewing sessions and history come next.

## Run it

```bash
cp stack.env.example stack.env   # optional: add SESSION_SECRET
docker compose up -d --build
```

Open `http://<your-server>:38471`. The first account you create becomes the admin. Sign-up then closes. To add people, go to **Settings → People and invites**, then either create accounts yourself or send invite links.

Data lives in the `setryx-data` volume (`/data` in the container): the SQLite database and the generated session secret.

The exercise library comes from [free-exercise-db](https://github.com/yuhonas/free-exercise-db) (public domain).

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

setryx works over plain HTTP. With HTTPS, phones can also open the app with no connection (installable app) and use the browser's own keep-screen-on feature. Two example proxies:

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

The API runs on :38471 and Vite on :5173 (it proxies `/api`). Other commands: `npm test` runs the API tests, `npm run typecheck` checks types, and `npm run build` builds the web app into `apps/web/dist`, which the server serves.

Layout: `apps/server` (Fastify + built-in `node:sqlite`), `apps/web` (React + Vite), `packages/shared` (Zod schemas used by both).
