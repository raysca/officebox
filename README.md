# Officebox

A self-owned, Cloudflare-native workspace for small teams: chat, calls, calendar, documents and files in one deployment. It runs in your own Cloudflare account, is open source under AGPL-3.0, and has no per-seat fees.

> **Status:** early development (milestone M1, Identity). The deployed app has first-run setup, email and password sign-in, "My devices" and the application shell (navigation, themes, empty areas). See [`PLAN.md`](PLAN.md) for the roadmap.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/raysca/officebox)

The button copies this repository into your GitHub account, provisions the D1 database, R2 bucket and queues, and runs:

```sh
npm run build    # builds the web app and checks the Worker bundle
npm run deploy   # preflight → wrangler d1 migrations apply DB --remote → wrangler deploy
```

R2 must be enabled on the Cloudflare account (dashboard → R2) before the first deploy. Sign-in needs **Workers Paid**: password hashing takes about 12 ms of CPU, above the Free plan's 10 ms limit. After deploying, open `https://<your-worker>.workers.dev/health`; it returns `{ "status": "ok", "version": "…" }`. Then set the [secrets](#secrets) and [set up the workspace](#first-run-setup).

To deploy by hand instead: `npx wrangler login`, create the database with `npx wrangler d1 create officebox` and add its `database_id` to `wrangler.jsonc`, then run `npm run build && npm run deploy`.

### Deploy from GitHub Actions

Instead of the Deploy button's Workers Builds, this repository can deploy itself from GitHub Actions (`.github/workflows/deploy.yml`). Pushes to `main` deploy once CI passes, and you can run it by hand: Actions → Deploy → Run workflow.

**Use one deploy path, not both.** If your copy came from the Deploy button, Workers Builds already deploys every push. Disconnect it (dashboard → your Worker → Settings → Builds → Disconnect) before adding the secrets below, or two deploys race on every push. Until both secrets exist, the workflow skips with a notice and the run shows as green.

1. **Enable R2** on the Cloudflare account (dashboard → R2; it needs a payment method). If the account has never had a `workers.dev` subdomain, register one (dashboard → Workers & Pages).
2. **Create an API token.** In the dashboard go to My Profile → API Tokens → Create Token → Create Custom Token. An account-owned token (Manage Account → Account API Tokens) also works. Scope it to the account you deploy to, with these **Account** permissions:
   - Workers Scripts: Edit
   - D1: Edit
   - Workers R2 Storage: Edit
   - Queues: Edit
   - Account Settings: Read

   If a deploy fails with an authorisation error naming another product, add that permission. Please tell us too, so we can update this list.
3. **Find your account ID**: dashboard → Workers & Pages → Account details.
4. **Add both to GitHub.** In the repository go to Settings → Environments → New environment and name it `production`.
   - Under **Deployment branches**, choose *Selected branches* and add `main`.
   - Add two environment secrets: `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` (the account ID).
   - Optionally add yourself under **Required reviewers**, so every deploy waits for your approval.

Each run checks out the commit CI tested, and deploys only if it is still the tip of `main`. It builds, then `npm run deploy:ci` runs these steps in order:
- **Preflight checks.**
- **Database.** Creates the `officebox` D1 database if the account has none by that name. It's found by name, so no ID is committed.
- **Migrations.** Applies D1 migrations.
- **Secrets (default).** Creates any of `SESSION_SIGNING_KEY`, `TOKEN_HASH_KEY` and `PEPPER_1` that the Worker doesn't have yet, each from 32 random bytes, so sign-in works on the first deploy. It never overwrites a secret that exists, never prints a value, and logs only "created NAME" or "NAME already set". It doesn't create `SETUP_TOKEN` (the Worker generates a one-time token into its logs instead), `SESSION_SIGNING_KEY_PREVIOUS` or `PEPPER_2` and up. If this step fails, the deploy stops before the new version goes live.
- **Deploy.** `wrangler deploy` creates the R2 bucket and queues on first use.

**The generated secrets live only in Cloudflare.** Nobody, including you, ever sees their values. That is fine for the signing and token keys, but **if `PEPPER_1` is ever lost (for example the Worker is deleted, or you restore an export into a new account), every password becomes unusable** and everyone must reset theirs. If you want a backup, set `PEPPER_1` yourself before the first deploy (`openssl rand -base64 32`, then `npx wrangler secret put PEPPER_1`) and keep a copy somewhere safe; the deploy then leaves it alone. To take over a generated value later, you can't read it back: set a new `PEPPER_2` and keep that instead (see [rotating the password pepper](#secrets)).

If a step fails, the run stops and the previous Worker version stays live. Migrations that already ran stay applied, which is safe by design (expand/contract, TDD §6.5).

Only the deploy step can read the token. Never paste it into an issue, pull request or chat; it belongs only in the GitHub secret.

## Secrets

Officebox reads these Worker secrets (full inventory and rotation rules: [platform §16](specs/platform.md#16-secrets-inventory)). Set each with `npx wrangler secret put <NAME>`, or in the dashboard (your Worker → Settings → Variables and Secrets → Add → Secret). Generate random values with `openssl rand -base64 32`; each must be at least 32 bytes, and no two may be the same.

| Secret | Required | Notes |
|---|---|---|
| `SESSION_SIGNING_KEY` | Yes | Signs the session cookie. To rotate, move the old value to `SESSION_SIGNING_KEY_PREVIOUS`, set a new one, and delete the previous key after 15 minutes (people stay signed in). |
| `TOKEN_HASH_KEY` | Yes | Keys the stored hashes of refresh tokens and other tokens. Changing it signs everyone out. |
| `PEPPER_1` | Yes | Mixed into every password hash and never stored in the database. **Keep a copy somewhere safe:** restoring an export to another installation needs the same `PEPPER_*` secrets, or every password must be reset. |
| `SETUP_TOKEN` | No | First-run setup token (at least 32 characters). Leave it unset to get a one-time token in the logs instead. Delete it after setup. |

Deploys from GitHub Actions create the three required secrets if they're missing ([above](#deploy-from-github-actions)). Other deploy paths (the Deploy button, `npm run deploy`) don't: set them yourself. Until the three required secrets are set, setup and sign-in answer "isn't configured yet", and the Worker logs which secret is missing (never its value).

**Rotating the password pepper.** Add `PEPPER_2` (then `PEPPER_3`, …): new and changed passwords use the highest number, and each person's password is re-hashed with it the next time they sign in. Announce a deadline; after it, delete the old pepper. Anyone who hasn't signed in by then can no longer sign in with their password and needs a reset (or a magic link or passkey, once those exist).

## First-run setup

Open your workspace's address. Until setup is done, every page leads to **Set up your workspace**, which asks for the setup token, the workspace name and the first owner's name, handle, email and password. Setup works exactly once; afterwards `/setup` is gone for good.

The setup token is either:
- the `SETUP_TOKEN` secret, if you set one, or
- a one-time token the Worker generates on the first visit. Find it in the dashboard: Workers & Pages → your Worker → Logs, in the entry **officebox setup token** (only members of your Cloudflare account can read these logs). It expires after 24 hours; visiting the setup page again after that writes a new one.

Setup is rate-limited and recorded in the audit log. For extra protection while the workspace is unclaimed, you can put Cloudflare Access in front of it until setup is done.

## Develop

Requires Node 22.22 or later.

```sh
npm install --legacy-peer-deps   # npm 10.9 crashes resolving peer dependencies without it (.npmrc sets it too)
cp .dev.vars.example .dev.vars   # local Worker secrets: fill in each value (openssl rand -base64 32)
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

## Web app

`apps/web` is a React 19 single-page app built with Vite and served through Workers Assets.

| Path | Contents |
|---|---|
| `src/app/router.tsx` | Routes, declared in code with TanStack Router (no route generator). Features add theirs under the root route. |
| `src/app/layout` | The shell: skip link, header, sidebar (a modal drawer below the `md` breakpoint), main content, footer |
| `src/app/messages.ts` | Interface text, kept in one place for translation later |
| `src/index.css` | Tailwind CSS and the design tokens (colours, spacing, radius, typography) for the light and dark themes |
| `src/lib/ui` | Small accessible primitives: Button, IconButton, Link, VisuallyHidden, EmptyState, Dialog, Toaster |
| `src/lib/api` | Typed `fetch` wrapper returning `Result`s, TanStack Query defaults and `useHealth()` |

- **Styling:** Tailwind utilities on the semantic tokens only (`bg-surface`, `text-muted`, `border-border-strong`, …); the default palette is removed. Both themes meet WCAG AA contrast, checked by `src/app/tokens.test.ts`.
- **Theme:** follows the system by default; the header's Theme control stores Light or Dark on the device (`localStorage`, key `officebox.theme`). `public/theme-init.js` applies it before first paint.
- **API calls:** use `apiRequest(path, { schema })` and `unwrap()` inside query functions. Writes get the `X-Officebox-Request: 1` header automatically. Queries retry network errors, timeouts, 5xx, 408 and 429 (honouring `Retry-After`, capped at 30 s); mutations never retry, and their failures show a toast unless `meta.errorToast` is `false`. People see copy chosen by error code (`messages.errors`), never the server's `message`. `createQueryClient({ onUnauthorized })` is the hook for expired sessions (M1).
- **CSP:** the app runs under TDD §8.2's `script-src 'self'` (an e2e test serves it with that header): no inline scripts or style attributes, and Zod runs in jitless mode (`src/lib/zod-config.ts`) so it never probes for eval.
- **Accessibility:** focus moves to the page's `h1` after each navigation, every page sets its document title through `<Page title>`, and Playwright runs axe (WCAG 2.2 AA) on every shell route in both themes.

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
