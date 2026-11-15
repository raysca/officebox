# Officebox

A self-owned, Cloudflare-native workspace for small teams: chat, calls, calendar, documents and files in one deployment. It runs in your own Cloudflare account, is open source under AGPL-3.0, and has no per-seat fees.

> **Status:** early development (milestone M1, Identity). The deployed app has first-run setup with a passkey, passkey sign-in (there are no passwords), invitations by link or email, email sign-in links for members, "My devices", passkey management and the application shell (navigation, themes, empty areas). Recovery links and profiles arrive next. See [`PLAN.md`](PLAN.md) for the roadmap.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/raysca/officebox)

The button copies this repository into your GitHub account, provisions the D1 database, R2 bucket and queues, and runs:

```sh
npm run build    # builds the web app and checks the Worker bundle
npm run deploy   # preflight → wrangler d1 migrations apply DB --remote → wrangler deploy
```

R2 must be enabled on the Cloudflare account (dashboard → R2) before the first deploy. After deploying, open `https://<your-worker>.workers.dev/health`; it returns `{ "status": "ok", "version": "…" }`. Then set the [secrets](#secrets) and [set up the workspace](#first-run-setup).

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
- **Secrets (default).** Creates `BETTER_AUTH_SECRET` and `TOKEN_HASH_KEY` if the Worker doesn't have them yet, each from 32 random bytes, so sign-in works on the first deploy. It never overwrites a secret that exists, never prints a value, and logs only "created NAME" or "NAME already set". It doesn't create `SETUP_TOKEN` (the Worker generates a one-time token into its logs instead), `BETTER_AUTH_SECRETS` or `RECOVERY_TOKEN`. If this step fails, the deploy stops before the new version goes live.
- **Deploy.** `wrangler deploy` creates the R2 bucket and queues on first use.

If a step fails, the run stops and the previous Worker version stays live. Migrations that already ran stay applied, which is safe by design (expand/contract, TDD §6.5).

Only the deploy step can read the token. Never paste it into an issue, pull request or chat; it belongs only in the GitHub secret.

## Secrets

Officebox reads these Worker secrets (full inventory and rotation rules: [platform §16](specs/platform.md#16-secrets-inventory)). Set each with `npx wrangler secret put <NAME>`, or in the dashboard (your Worker → Settings → Variables and Secrets → Add → Secret). Generate random values with `openssl rand -base64 32`; each must be at least 32 bytes, and no two may be the same.

| Secret | Required | Notes |
|---|---|---|
| `BETTER_AUTH_SECRET` | Yes | Signs the session cookie (better-auth). **Changing it signs everyone out**: the cookie is signed with the newest secret only. To rotate, set `BETTER_AUTH_SECRETS` to `2:<new>,1:<old>` (newest first), tell members they'll need to sign in again, and after 30 days set `BETTER_AUTH_SECRET` to the new value and delete `BETTER_AUTH_SECRETS`. |
| `TOKEN_HASH_KEY` | Yes | Keys the stored hashes of our tokens (passkey enrolment tickets, invitation links, sign-in links and known devices; recovery and email-change links later). Changing it invalidates outstanding links. |
| `SETUP_TOKEN` | No | First-run setup token (at least 32 characters). Leave it unset to get a one-time token in the logs instead. Delete it after setup. |
| `RECOVERY_TOKEN` | No | Owner recovery when every owner has lost their passkeys (at least 32 characters; arrives with recovery links). While it's set and unused, it also lets an owner with one passkey invite people. |
| `RESEND_API_KEY` | No | Only with the Resend email service ([Email](#email)). |
| `POSTMARK_SERVER_TOKEN` | No | Only with the Postmark email service. |
| `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | No | Only with Amazon SES: an IAM user allowed only `ses:SendEmail`. |
| `SMTP_PASSWORD` | No | Only with an SMTP server (the username is a setting). |

Deploys from GitHub Actions create the two required secrets if they're missing ([above](#deploy-from-github-actions)). Other deploy paths (the Deploy button, `npm run deploy`) don't: set them yourself. Until both are set, setup and sign-in show "This workspace isn't fully configured yet", and the Worker logs which secret is missing (never its value).

There are no passwords, so there are no password peppers to keep: lost passkeys are replaced, not recovered (Identity §4.6).

## First-run setup

Open your workspace's address **on the domain you'll keep using**: the address setup runs on becomes the workspace's canonical origin, and passkeys are bound to it. Until setup is done, every page leads to **Set up your workspace**, which checks that the browser can create a passkey, then asks for the setup token, the workspace name and the first owner's name, handle and email. The owner then creates a passkey (this device's screen lock, a phone, or a security key with a PIN or biometric; user verification is required). Setup is complete once that passkey exists, and `/setup` is gone for good. Add a second passkey straight away if you can: an owner with one passkey can't invite anyone until they add another (or set `RECOVERY_TOKEN`).

The setup token is either:
- the `SETUP_TOKEN` secret, if you set one, or
- a one-time token the Worker generates on the first visit. Find it in the dashboard: Workers & Pages → your Worker → Logs, in the entry **officebox setup token** (only members of your Cloudflare account can read these logs). It expires after 24 hours; visiting the setup page again after that writes a new one.

If you leave before creating the passkey, open `/setup` again (on any device) and enter the same token to continue. An unfinished setup is released 24 hours after it started. On a `*.workers.dev` address the workspace usually has no email, so a second passkey matters even more; moving to a custom domain later means adding passkeys again.

Setup is rate-limited and recorded in the audit log. For extra protection while the workspace is unclaimed, you can put Cloudflare Access in front of it until setup is done.

## Inviting people

Owners and admins invite people from **Admin → Invitations**: enter the person's email and a role (admins invite members; only owners invite admins), then share the link that appears. The link works once, only for that email, and expires after 7 days. With email set up, the invitation can be emailed too. Pending invitations can be copied again, resent or revoked. Accepting asks for a name and @handle, then a passkey; there's no password. An owner needs a second passkey (or `RECOVERY_TOKEN` set) before inviting anyone.

## Email

Email is optional: copy-link invitations always work without it. With it, invitations can be emailed, **members** can sign in with an emailed link (owners and admins always use a passkey), and security notices (a passkey added, a sign-in link used from a new device, a copied passkey refused) are emailed as well as shown in the app.

An owner turns it on in **Admin → Settings → Email**: choose the service and enter the **sender address** (Officebox never assumes a domain), then **Send test email**, which goes to your own address.

| Service | Needs |
|---|---|
| Cloudflare Email Service (recommended) | The sending domain on Cloudflare DNS and onboarded in Email Service (dashboard → Email), on Workers Paid. No keys: the Worker's `EMAIL` binding is already in `wrangler.jsonc`. Not available on a `*.workers.dev` address alone. |
| Resend, Postmark or Amazon SES | An account with your sending domain verified, and its key as a Worker secret ([Secrets](#secrets)). SES also needs its region in settings. |
| SMTP | Your provider's submission server on port 587 (STARTTLS) or 465 (TLS), a username in settings and `SMTP_PASSWORD` as a secret. Port 25 isn't available from Workers. |

Settings shows what's missing (by secret name) until the service can send. Mail goes through the `officebox-email` queue: temporary failures are retried for up to about two hours (8 tries), and mail that still can't be sent lands in the `officebox-email-dlq` queue. **Sign-in links** can be turned off under Admin → Settings, and **allowed invitation domains** limit who can be invited.

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
