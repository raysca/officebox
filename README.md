# Officebox

A self-owned, Cloudflare-native workspace for small teams: chat, calls, calendar, documents and files in one deployment. It runs in your own Cloudflare account, is open source under AGPL-3.0, and has no per-seat fees.

> **Status:** early development (milestone M0, Foundation). The deployed app is a placeholder page and a `/health` endpoint. See [`PLAN.md`](PLAN.md) for the roadmap.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/raysca/officebox)

The button copies this repository into your GitHub account, provisions the D1 database, R2 bucket and queues, and runs:

```sh
npm run build    # builds the web app and checks the Worker bundle
npm run deploy   # preflight → wrangler d1 migrations apply DB --remote → wrangler deploy
```

R2 must be enabled on the Cloudflare account (dashboard → R2) before the first deploy. After deploying, open `https://<your-worker>.workers.dev/health`; it returns `{ "status": "ok", "version": "…" }`.

To deploy by hand instead: `npx wrangler login`, create the database with `npx wrangler d1 create officebox` and add its `database_id` to `wrangler.jsonc`, then run `npm run build && npm run deploy`.

## Develop

Requires Node 22.22 or later.

```sh
npm install --legacy-peer-deps   # npm 10.9 crashes resolving peer dependencies without it (.npmrc sets it too)
cp .dev.vars.example .dev.vars   # local Worker secrets
npm run dev                      # Worker on :8787, web app with hot reload on http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm run dev` | `wrangler dev` plus the Vite dev server (applies local D1 migrations first) |
| `npm run build` | Builds the web app into `apps/web/dist` and dry-runs the Worker bundle |
| `npm run typecheck` | TypeScript in every workspace |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm test` | Unit tests (shared, web) and Worker integration tests in the Workers runtime |
| `npm run e2e` | Builds, then runs Playwright against `wrangler dev` |
| `npm run deploy` | Preflight, remote D1 migrations, deploy |

## Repository layout

| Path | Contents |
|---|---|
| `apps/worker` | Cloudflare Worker (Hono) and Durable Objects; D1 migrations in `apps/worker/migrations` |
| `apps/web` | React web app (Vite), served through Workers Assets |
| `packages/shared` | Types and Zod schemas shared by the Worker and the web app |
| `e2e` | Playwright end-to-end tests |
| `wrangler.jsonc` | Worker configuration and bindings. At the root because the Deploy button reads it there. |
| `scripts` | `dev.mjs` (local development) and `preflight.mjs` (deploy checks) |
| `spikes` | Reference prototypes; never imported |

## Contributing

Read [`AGENTS.md`](AGENTS.md) first: it sets out the workflow, conventions and definition of done, and points to the PRD, specs, TDD and plan.

## Licence

GNU Affero General Public License v3.0 or later. See [`LICENSE`](LICENSE).
