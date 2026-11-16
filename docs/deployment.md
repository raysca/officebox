# Deploying Officebox

This guide takes you from an empty Cloudflare account to a working workspace with its first owner and, optionally, email and file storage. It covers:

1. [Before you start](#1-before-you-start)
2. [Choose your address](#2-choose-your-address)
3. [Deploy](#3-deploy): the Deploy button, GitHub Actions, or by hand
4. [Secrets](#4-secrets)
5. [Check the deployment](#5-check-the-deployment)
6. [First-time setup](#6-first-time-setup)
7. [Turn on email](#7-turn-on-email) (optional)
8. [Turn on file storage](#8-turn-on-file-storage) (optional)
9. [Invite your team](#9-invite-your-team)
10. [Updating, rolling back and troubleshooting](#10-updating-rolling-back-and-troubleshooting)

## Quick start

To try Officebox with almost no setup:

1. **Deploy** with the Deploy to Cloudflare button ([step 3](#option-a-deploy-to-cloudflare-button)).
2. **Open the address and finish within the hour.** For the first 60 minutes after the setup page is first opened, setup needs no setup token. The page shows how long is left.
3. **Create your passkey.** Enter the workspace name and your name, @handle and email, then create a passkey when the browser asks.

You don't need to set any secrets, and you don't need R2. The Worker generates its own sign-in keys, and file storage can be turned on later.

> **Until setup is done, anyone who opens the address in that first hour can claim the workspace.** Do it straight away. If you'd rather not take that chance, set a `SETUP_TOKEN` secret before opening the address: then there's no open hour at all ([step 6](#6-first-time-setup)).

> Quick start arrives with milestone M1b-1. Until your deployment includes it, use the setup token ([step 6](#6-first-time-setup)) and set the two secrets in [step 4](#4-secrets).

For a workspace your team will rely on, follow the full guide: a custom domain first, sign-in keys as Worker secrets, and a second passkey.

Throughout, `<your-domain>` stands for the address your workspace will use, for example `office.example.com`, and `<your-worker>` for your `workers.dev` subdomain. Officebox never assumes a domain: everything deployment-specific comes from your Cloudflare account, your Worker secrets and the admin settings.

## 1. Before you start

You need:

- **A Cloudflare account.** The free plan runs the core app. **Workers Paid** is needed for Cloudflare Email Service, and is recommended for production limits.
- **R2 is optional.** You need it only to store files (avatars, attachments, documents' files and exports, as those features arrive). Enabling it needs a payment method on file, even within the free allowance. See [step 8](#8-turn-on-file-storage).
- **A `workers.dev` subdomain** if the account has never had one: dashboard → Workers & Pages.
- **A domain on Cloudflare DNS** (recommended). You need one for a custom address and for Cloudflare Email Service.
- **A device that can create passkeys** for the first owner: a phone, a laptop with a screen lock (Touch ID, Windows Hello and so on), or a security key with a PIN or biometric. Two devices are better (see [step 6](#6-first-time-setup)).

For a local deploy, also Node.js 22 and npm.

## 2. Choose your address

**Decide this before first-time setup.** The address you run setup on becomes the workspace's canonical origin. Passkeys are bound to it, and every emailed link is built from it. Moving later means every person adds their passkeys again.

| Option | When to use it |
|---|---|
| **Custom domain** such as `<your-domain>` (recommended) | Any real workspace. Needed for Cloudflare Email Service. |
| `https://officebox.<your-worker>.workers.dev` | Trying Officebox out, for example with the [quick start](#quick-start). Email through Cloudflare Email Service isn't available on this address alone. |

To use a custom domain, add it to the Worker **after the first deploy and before setup**: dashboard → Workers & Pages → `officebox` → Settings → Domains & Routes → Add → Custom domain → `<your-domain>`. Cloudflare creates the DNS record and certificate. Wait until `https://<your-domain>/health` answers before going on.

## 3. Deploy

Pick **one** of these paths. Don't use two at once, or deploys race on every push.

### Option A: Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/raysca/officebox)

The button copies the repository into your GitHub account, provisions the D1 database and queues, and runs `npm run build` and `npm run deploy` (preflight → D1 migrations → `wrangler deploy`). Workers Builds then redeploys every push to your copy.

The button may prompt for secrets. You can leave them all empty: the Worker generates its own sign-in keys. For a production workspace, set them ([step 4](#4-secrets)).

### Option B: GitHub Actions

The repository can deploy itself from `.github/workflows/deploy.yml`. Pushes to `main` deploy once CI passes, and you can also run it by hand: Actions → Deploy → Run workflow.

If your copy came from the Deploy button, first disconnect Workers Builds: dashboard → your Worker → Settings → Builds → Disconnect.

1. **Create an API token.** Dashboard → My Profile → API Tokens → Create Token → Create Custom Token, scoped to your account, with these **Account** permissions:
   - Workers Scripts: Edit
   - D1: Edit
   - Queues: Edit
   - Account Settings: Read
   - Workers R2 Storage: Edit, only once you [turn on file storage](#8-turn-on-file-storage)

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
4. Creates `BETTER_AUTH_SECRET` and `TOKEN_HASH_KEY` as Worker secrets if they're missing. It never overwrites or prints them.
5. Runs `wrangler deploy`, which creates the queues (and the R2 bucket, if you turned on file storage) on first use.

If you move a workspace that's already in use from the Deploy button to GitHub Actions, step 4 replaces the keys the Worker generated: everyone is signed out once, and outstanding invitation and sign-in links stop working ([step 4](#4-secrets)). Do it at a quiet time.

Until both GitHub secrets exist, the workflow skips with a notice. Never paste the API token anywhere except the GitHub secret.

### Option C: By hand

```sh
npm install --legacy-peer-deps
npx wrangler login
npx wrangler d1 create officebox     # copy the database_id it prints into wrangler.jsonc (don't commit it)
npm run build
npm run deploy                       # preflight → migrations → wrangler deploy
```

Secrets are optional ([step 4](#4-secrets)).

## 4. Secrets

Set secrets with `npx wrangler secret put <NAME>`, or in the dashboard: your Worker → Settings → Variables and Secrets → Add → Secret. Generate values with `openssl rand -base64 32`. Each must be at least 32 bytes, and no two may be the same.

**Sign-in keys: recommended for production.** GitHub Actions creates these for you. With the button or a manual deploy, the Worker generates its own if you don't set them:

| Secret | What it does |
|---|---|
| `BETTER_AUTH_SECRET` | Signs session cookies. Changing it signs everyone out (rotation: [README → Secrets](../README.md#secrets)). |
| `TOKEN_HASH_KEY` | Keys the stored hashes of invitation links, sign-in links, enrolment tickets and known devices. Changing it invalidates outstanding links. |

**Keys generated by the Worker.** When one of these isn't set, the Worker creates a random key the first time it needs one and keeps it in the workspace's own Durable Object storage. It never goes into the database, logs, exports or any screen. A Worker secret, when set, always wins. **Admin → Settings** shows which you're using for each key ("Generated by the Worker" or "Worker secret"), never the value.

Generated keys are fine for trying Officebox. For production, set Worker secrets, **ideally before first-time setup**. Worker secrets can't be read back from the dashboard or the API, while Durable Object storage can be read by code deployed to the Worker and by account members with access to its data. Setting them on a workspace that's already in use has a one-time cost:

- `BETTER_AUTH_SECRET` signs everyone out. People sign in again with a passkey or a sign-in link.
- `TOKEN_HASH_KEY` makes outstanding invitation, sign-in and other emailed links stop working (copy or resend invitations), and each member's next emailed sign-in counts as a new device.
- Deleting a Worker secret later switches back to the generated key, with the same effects.

If a secret is set but too short, setup and sign-in show "This workspace isn't fully configured yet", and the Worker log names the secret, never its value. An empty secret counts as not set.

**Optional:**

| Secret | When |
|---|---|
| `SETUP_TOKEN` | Your own first-run setup token, at least 32 characters. **Setting it turns off the open first hour**: setup always needs the token. Without it, setup needs no token for the first hour, and after that the Worker generates a one-time token into its logs. Delete it after setup. |
| `RECOVERY_TOKEN` | Owner recovery if every owner loses their passkeys. While it's set and unused, it also lets an owner with one passkey invite people. Keep a copy somewhere safe and offline. |
| `RESEND_API_KEY`, `POSTMARK_SERVER_TOKEN`, `SES_ACCESS_KEY_ID` + `SES_SECRET_ACCESS_KEY`, `SMTP_PASSWORD` | Only for the matching email service ([step 7](#7-turn-on-email)). |

Never put secrets in `wrangler.jsonc`, the repository, D1 or chat. Full inventory: [platform §16](../specs/platform.md#16-secrets-inventory).

## 5. Check the deployment

Open `https://<your-domain>/health`, or the `workers.dev` address. You should see:

```json
{ "status": "ok", "version": "…" }
```

`https://<your-domain>/api/setup` should report `"setupRequired": true` and `"claimed": false`, and `"mode"`: `"open"` (with `"openUntil"`) during the first hour after it was first opened, or `"token"`. Opening it counts as opening the workspace, so the hour starts then. If `/health` reports a failing check, see [troubleshooting](#troubleshooting).

## 6. First-time setup

Do this **on the address you'll keep** ([step 2](#2-choose-your-address)), as soon as possible after deploying.

**Do you need a setup token?**

- **No `SETUP_TOKEN` secret, within the first hour:** no token. The hour starts the first time anyone opens the setup page, not when you deploy. The page says how long is left. Until setup is claimed, **anyone who opens the address in that hour can claim the workspace**.
- **After that hour:** the Worker's one-time token from the logs (step 1).
- **`SETUP_TOKEN` set:** always that token. There's no open hour. Choose this if the address might be found before you get to it, or put Cloudflare Access in front of the site until setup is done.

1. **Get the setup token, if you need one.**
   - If you set `SETUP_TOKEN`, that's the token.
   - Otherwise, open `https://<your-domain>/setup` once. Then, in the dashboard, go to Workers & Pages → `officebox` → Logs and find the entry **officebox setup token**. Only members of your Cloudflare account can read these logs. The token expires after 24 hours; visiting `/setup` again after that writes a new one. It also works during the open hour.
2. **Open `https://<your-domain>/setup`.** It checks that this browser can create a passkey.
3. **Enter** the setup token if asked, the workspace name, and the first owner's name, @handle and email. If you claimed without a token, the page shows a **setup resume code** once: keep it until your passkey exists, in case you need to continue on another device.
4. **Create a passkey** when the browser asks: screen lock, phone or security key. User verification (PIN or biometric) is required. Setup is complete once this passkey exists, and `/setup` is then gone for good.
5. **Add a second passkey straight away**, on another device: account menu → Passkeys → Add a passkey. An owner with only one passkey can't invite anyone until they add a second one or set `RECOVERY_TOKEN`. This is your safety net: there are no passwords, so lost passkeys are replaced, not recovered.
6. **Tidy up.** If you set `SETUP_TOKEN`, delete it now: `npx wrangler secret delete SETUP_TOKEN`. For production, set the sign-in keys as Worker secrets ([step 4](#4-secrets)) before you invite anyone.

If you leave before step 4, open `/setup` again on any device and enter the same token (or the setup resume code) to continue. An unfinished setup is released 24 hours after it started.

### If someone else claimed it, or setup went wrong

Every claim writes an entry **officebox setup claimed** to the Worker's logs, with the time, address and country.

- **Unfinished** (no passkey created yet): release it now instead of waiting 24 hours. This also ends the open hour, so setup then needs a token:

  ```sh
  npx wrangler d1 execute officebox --remote --file scripts/setup-release.sql
  ```

  It never removes an owner who has created a passkey or signed in.
- **Finished by someone else:** start over. Nothing of yours is in the workspace yet. In the dashboard, delete the `officebox` Worker and the `officebox` D1 database, then deploy again. This time, set `SETUP_TOKEN` first or open the address straight away.

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

## 8. Turn on file storage

File storage uses R2. It's off by default, so you can deploy without R2. Until it's on, features that store files say so, and owners and admins see "File storage isn't set up". Today's milestone stores no files yet; avatars, attachments, document files and exports use it as they arrive.

1. **Enable R2** on the account: dashboard → R2. It needs a payment method on file.
2. **Add the binding.** In your copy of the repository, open `wrangler.jsonc` and uncomment the `r2_buckets` block for the `FILES` binding.
3. **Deploy** (push to `main`, or run `npm run deploy`). `wrangler deploy` creates the bucket. With GitHub Actions, add *Workers R2 Storage: Edit* to the API token first.

Upgrades keep the block. Don't remove it once files exist: they stay in the bucket but can't be reached until it's added back.

## 9. Invite your team

Go to **Admin → Invitations → Invite**, and enter an email and a role. Admins invite members; only owners invite admins.

- **Copy the link** and share it any way you like, or let Officebox email it if email is on.
- Each link works once, only for that email address, and expires after 7 days.
- The person picks a name and @handle, then creates a passkey.

Pending invitations can be copied again, resent or revoked.

## 10. Updating, rolling back and troubleshooting

### Updating

- **GitHub Actions or the button:** merge or push to `main`. Migrations run before the new version goes live, and they only add to the schema (expand/contract), so the running version keeps working.
- **By hand:** pull, then run `npm run build && npm run deploy`.

### Rolling back

Dashboard → your Worker → Deployments → pick the previous version → Rollback. Migrations aren't rolled back, and don't need to be: they are additive, so an older version runs on the newer schema.

### Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| "This workspace isn't fully configured yet" | `BETTER_AUTH_SECRET` or `TOKEN_HASH_KEY` is set but shorter than 32 bytes, or `BETTER_AUTH_SECRETS` is malformed. The Worker logs name it. Fix or delete it ([step 4](#4-secrets)). |
| Setup asks for a token, but you didn't set one | The open hour has passed: it started the first time anyone opened the setup page. Use the token from the logs ([step 6](#6-first-time-setup)). |
| Everyone was signed out after a deploy | `BETTER_AUTH_SECRET` was set (or deleted) on a workspace using keys generated by the Worker, for example by the GitHub Actions deploy's first run. People sign in again ([step 4](#4-secrets)). |
| "Setup isn't configured correctly. Check the SETUP_TOKEN secret." | `SETUP_TOKEN` is shorter than 32 characters. Lengthen it or delete it. |
| No **officebox setup token** in the logs | Open `/setup` once to generate it, then refresh the Logs view. Check that observability is enabled on the Worker. |
| "The setup token is not valid." | It expired after 24 hours, or it's from a different visit. Open `/setup` again and use the newest token. |
| Passkey prompt fails or offers no passkeys | You're on a different address from the one setup ran on. Passkeys only work on the canonical origin. |
| Deploy fails with an R2 error | You added the `FILES` binding before enabling R2 on the account (dashboard → R2), or the API token lacks *Workers R2 Storage: Edit* ([step 8](#8-turn-on-file-storage)). |
| GitHub deploy shows green but nothing deployed | The `production` environment secrets are missing (the workflow skips with a notice), or a newer commit superseded the run. |
| Test email never arrives | Settings shows a missing secret, the domain isn't onboarded or verified with the provider, or the message is waiting on a retry. Check the Worker logs. |
| "Too many requests" while several people join at once | The per-IP limit on invitation pages (5 a minute). Wait a minute and try again. |
