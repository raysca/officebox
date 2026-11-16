# Deploying Officebox

This guide takes you from an empty Cloudflare account to a working workspace with its first owner and, optionally, email. It covers:

1. [Before you start](#1-before-you-start)
2. [Choose your address](#2-choose-your-address)
3. [Deploy](#3-deploy): the Deploy button, GitHub Actions, or by hand
4. [Secrets](#4-secrets)
5. [Check the deployment](#5-check-the-deployment)
6. [First-time setup](#6-first-time-setup)
7. [Turn on email](#7-turn-on-email) (optional)
8. [Invite your team](#8-invite-your-team)
9. [Updating, rolling back and troubleshooting](#9-updating-rolling-back-and-troubleshooting)

Throughout, `<your-domain>` stands for the address your workspace will use, for example `office.example.com`, and `<your-worker>` for your `workers.dev` subdomain. Officebox never assumes a domain: everything deployment-specific comes from your Cloudflare account, your Worker secrets and the admin settings.

## 1. Before you start

You need:

- **A Cloudflare account.** The free plan runs the core app. **Workers Paid** is needed for Cloudflare Email Service, and is recommended for production limits.
- **R2 enabled** on the account: dashboard → R2. This needs a payment method on file, even if you stay within the free allowance.
- **A `workers.dev` subdomain** if the account has never had one: dashboard → Workers & Pages.
- **A domain on Cloudflare DNS** (recommended). You need one for a custom address and for Cloudflare Email Service.
- **A device that can create passkeys** for the first owner: a phone, a laptop with a screen lock (Touch ID, Windows Hello and so on), or a security key with a PIN or biometric. Two devices are better (see [step 6](#6-first-time-setup)).

For a local deploy, also Node.js 22 and npm.

## 2. Choose your address

**Decide this before first-time setup.** The address you run setup on becomes the workspace's canonical origin. Passkeys are bound to it, and every emailed link is built from it. Moving later means every person adds their passkeys again.

| Option | When to use it |
|---|---|
| **Custom domain** such as `<your-domain>` (recommended) | Any real workspace. Needed for Cloudflare Email Service. |
| `https://officebox.<your-worker>.workers.dev` | Trying Officebox out. Email through Cloudflare Email Service isn't available on this address alone. |

To use a custom domain, add it to the Worker **after the first deploy and before setup**: dashboard → Workers & Pages → `officebox` → Settings → Domains & Routes → Add → Custom domain → `<your-domain>`. Cloudflare creates the DNS record and certificate. Wait until `https://<your-domain>/health` answers before going on.

## 3. Deploy

Pick **one** of these paths. Don't use two at once, or deploys race on every push.

### Option A: Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/raysca/officebox)

The button copies the repository into your GitHub account, provisions the D1 database, R2 bucket and queues, and runs `npm run build` and `npm run deploy` (preflight → D1 migrations → `wrangler deploy`). Workers Builds then redeploys every push to your copy.

The button **does not create secrets**. Set the two required ones yourself afterwards ([step 4](#4-secrets)).

### Option B: GitHub Actions

The repository can deploy itself from `.github/workflows/deploy.yml`. Pushes to `main` deploy once CI passes, and you can also run it by hand: Actions → Deploy → Run workflow.

If your copy came from the Deploy button, first disconnect Workers Builds: dashboard → your Worker → Settings → Builds → Disconnect.

1. **Create an API token.** Dashboard → My Profile → API Tokens → Create Token → Create Custom Token, scoped to your account, with these **Account** permissions:
   - Workers Scripts: Edit
   - D1: Edit
   - Workers R2 Storage: Edit
   - Queues: Edit
   - Account Settings: Read

   An account-owned token (Manage Account → Account API Tokens) works too. If a deploy fails with an authorisation error naming another product, add that permission.
2. **Find your account ID**: dashboard → Workers & Pages → Account details.
3. **Add them to GitHub.** Repository → Settings → Environments → New environment named `production`.
   - Deployment branches: *Selected branches* → `main`.
   - Environment secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
   - Optionally add yourself as a required reviewer, so each deploy waits for your approval.
4. **Push to `main`, or run the workflow.**

Each run deploys the commit CI tested, and only if it is still the tip of `main`. `npm run deploy:ci` then runs these steps in order:

1. Preflight checks.
2. Creates the `officebox` D1 database if the account has none by that name.
3. Applies D1 migrations.
4. Creates `BETTER_AUTH_SECRET` and `TOKEN_HASH_KEY` if they're missing. It never overwrites or prints them.
5. Runs `wrangler deploy`, which creates the R2 bucket and queues on first use.

Until both GitHub secrets exist, the workflow skips with a notice. Never paste the API token anywhere except the GitHub secret.

### Option C: By hand

```sh
npm install --legacy-peer-deps
npx wrangler login
npx wrangler d1 create officebox     # copy the database_id it prints into wrangler.jsonc (don't commit it)
npm run build
npm run deploy                       # preflight → migrations → wrangler deploy
```

Then set the secrets ([step 4](#4-secrets)).

## 4. Secrets

Set secrets with `npx wrangler secret put <NAME>`, or in the dashboard: your Worker → Settings → Variables and Secrets → Add → Secret. Generate values with `openssl rand -base64 32`. Each must be at least 32 bytes, and no two may be the same.

**Required.** GitHub Actions creates these for you. With the button or a manual deploy, set them yourself:

| Secret | What it does |
|---|---|
| `BETTER_AUTH_SECRET` | Signs session cookies. Changing it signs everyone out (rotation: [README → Secrets](../README.md#secrets)). |
| `TOKEN_HASH_KEY` | Keys the stored hashes of invitation links, sign-in links, enrolment tickets and known devices. Changing it invalidates outstanding links. |

Until both are set, setup and sign-in show "This workspace isn't fully configured yet". The Worker log names the missing secret, never its value.

**Optional:**

| Secret | When |
|---|---|
| `SETUP_TOKEN` | Your own first-run setup token, at least 32 characters. Without it, the Worker generates a one-time token into its logs. Delete it after setup. |
| `RECOVERY_TOKEN` | Owner recovery if every owner loses their passkeys. While it's set and unused, it also lets an owner with one passkey invite people. Keep a copy somewhere safe and offline. |
| `RESEND_API_KEY`, `POSTMARK_SERVER_TOKEN`, `SES_ACCESS_KEY_ID` + `SES_SECRET_ACCESS_KEY`, `SMTP_PASSWORD` | Only for the matching email service ([step 7](#7-turn-on-email)). |

Never put secrets in `wrangler.jsonc`, the repository, D1 or chat. Full inventory: [platform §16](../specs/platform.md#16-secrets-inventory).

## 5. Check the deployment

Open `https://<your-domain>/health`, or the `workers.dev` address. You should see:

```json
{ "status": "ok", "version": "…" }
```

`https://<your-domain>/api/setup` should report `"setupRequired": true` and `"claimed": false`. If `/health` reports a failing check, see [troubleshooting](#troubleshooting).

## 6. First-time setup

Do this **on the address you'll keep** ([step 2](#2-choose-your-address)), as soon as possible after deploying. Until setup is claimed, anyone with the setup token can claim the workspace. For extra protection, put Cloudflare Access in front of the site until setup is done.

1. **Get the setup token.**
   - If you set `SETUP_TOKEN`, that's the token.
   - Otherwise, open `https://<your-domain>/setup` once. Then, in the dashboard, go to Workers & Pages → `officebox` → Logs and find the entry **officebox setup token**. Only members of your Cloudflare account can read these logs. The token expires after 24 hours; visiting `/setup` again after that writes a new one.
2. **Open `https://<your-domain>/setup`.** It checks that this browser can create a passkey.
3. **Enter** the setup token, the workspace name, and the first owner's name, @handle and email.
4. **Create a passkey** when the browser asks: screen lock, phone or security key. User verification (PIN or biometric) is required. Setup is complete once this passkey exists, and `/setup` is then gone for good.
5. **Add a second passkey straight away**, on another device: account menu → Passkeys → Add a passkey. An owner with only one passkey can't invite anyone until they add a second one or set `RECOVERY_TOKEN`. This is your safety net: there are no passwords, so lost passkeys are replaced, not recovered.
6. **Tidy up.** If you set `SETUP_TOKEN`, delete it now: `npx wrangler secret delete SETUP_TOKEN`.

If you leave before step 4, open `/setup` again on any device and enter the same token to continue. An unfinished setup is released 24 hours after it started.

## 7. Turn on email

Email is optional: invitations always work by copying the link. Turning it on adds emailed invitations, emailed sign-in links for **members** (owners and admins always use a passkey), and security notices by email.

### Cloudflare Email Service (recommended)

1. Your sending domain must be on Cloudflare DNS, and the account on Workers Paid.
2. In the dashboard, open **Email** → Email Sending and onboard the domain. Cloudflare adds the DNS records it needs (SPF, DKIM).
3. Nothing else to deploy: the Worker's `EMAIL` binding is already in `wrangler.jsonc`.

### Other services

| Service | Set up |
|---|---|
| Resend | Verify your domain in Resend, then set `RESEND_API_KEY`. |
| Postmark | Verify your sender signature or domain, then set `POSTMARK_SERVER_TOKEN`. |
| Amazon SES | Verify the domain, create an IAM user allowed only `ses:SendEmail`, then set `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY`. You choose the region in settings. |
| SMTP | Use your provider's submission server on port 587 (STARTTLS) or 465 (TLS); port 25 isn't available from Workers. Set `SMTP_PASSWORD`; the host and username go in settings. |

### Switch it on

1. Sign in as an owner and go to **Admin → Settings → Email**.
2. Choose the service and enter the **sender address**, for example `no-reply@<your-domain>`. Settings lists any missing secret by name.
3. Press **Send test email**. It goes to your own address and is limited to 5 an hour.

If the test email doesn't arrive, check the Worker logs for the delivery outcome. Temporary failures are retried for up to about two hours. Mail that still can't be sent lands in the `officebox-email-dlq` queue; links in it are still live until they expire, so treat it as sensitive.

Also under Admin → Settings: turn **sign-in links** off, or limit **allowed invitation domains**.

## 8. Invite your team

Go to **Admin → Invitations → Invite**, and enter an email and a role. Admins invite members; only owners invite admins.

- **Copy the link** and share it any way you like, or let Officebox email it if email is on.
- Each link works once, only for that email address, and expires after 7 days.
- The person picks a name and @handle, then creates a passkey.

Pending invitations can be copied again, resent or revoked.

## 9. Updating, rolling back and troubleshooting

### Updating

- **GitHub Actions or the button:** merge or push to `main`. Migrations run before the new version goes live, and they only add to the schema (expand/contract), so the running version keeps working.
- **By hand:** pull, then run `npm run build && npm run deploy`.

### Rolling back

Dashboard → your Worker → Deployments → pick the previous version → Rollback. Migrations aren't rolled back, and don't need to be: they are additive, so an older version runs on the newer schema.

### Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| "This workspace isn't fully configured yet" | `BETTER_AUTH_SECRET` or `TOKEN_HASH_KEY` is missing. The Worker logs name it. Set it ([step 4](#4-secrets)). |
| "Setup isn't configured correctly. Check the SETUP_TOKEN secret." | `SETUP_TOKEN` is shorter than 32 characters. Lengthen it or delete it. |
| No **officebox setup token** in the logs | Open `/setup` once to generate it, then refresh the Logs view. Check that observability is enabled on the Worker. |
| "The setup token is not valid." | It expired after 24 hours, or it's from a different visit. Open `/setup` again and use the newest token. |
| Passkey prompt fails or offers no passkeys | You're on a different address from the one setup ran on. Passkeys only work on the canonical origin. |
| Deploy fails on the first run with an R2 error | R2 isn't enabled on the account (dashboard → R2). |
| GitHub deploy shows green but nothing deployed | The `production` environment secrets are missing (the workflow skips with a notice), or a newer commit superseded the run. |
| Test email never arrives | Settings shows a missing secret, the domain isn't onboarded or verified with the provider, or the message is waiting on a retry. Check the Worker logs. |
| "Too many requests" while several people join at once | The per-IP limit on invitation pages (5 a minute). Wait a minute and try again. |
