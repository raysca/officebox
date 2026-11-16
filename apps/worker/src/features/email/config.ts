import { connect } from "cloudflare:sockets";
import { EMAIL_DRIVER_SECRETS, type EmailProvider, type EmailStatus } from "@officebox/shared";
import type { CoreContext } from "../../core/context";
import { SETTINGS, SettingsStore } from "../../core/settings";
import type { Env } from "../../env";
import { cloudflareDriver } from "./drivers/cloudflare";
import { postmarkDriver, resendDriver, sesDriver } from "./drivers/http";
import { sinkAllowed, sinkDriver } from "./drivers/sink";
import { smtpDriver, type SmtpConnect } from "./drivers/smtp";
import type { EmailDriver, Fetch } from "./drivers/types";

/**
 * Which email driver is in use and whether it can send (TDD §7.6). The driver and sender come from the
 * owner-only `email_provider` setting; provider keys from Worker secrets (Platform §16). Email is
 * **configured** only when a driver is chosen and everything it needs is present, so a half-finished
 * configuration never makes the app offer email it can't send.
 */

/** Secret names (and the binding) the chosen driver still lacks; never their values. */
export function missingForDriver(env: Env, provider: EmailProvider): string[] {
  if (provider.driver === "cloudflare") return env.EMAIL ? [] : ["EMAIL (send_email binding)"];
  return EMAIL_DRIVER_SECRETS[provider.driver].filter((name) => {
    const value = (env as unknown as Record<string, unknown>)[name];
    return typeof value !== "string" || value.trim() === "";
  });
}

export function emailStatus(env: Env, provider: EmailProvider): EmailStatus {
  if (provider.driver === "none") return { driver: "none", configured: false, missing: [] };
  const missing = missingForDriver(env, provider);
  return { driver: provider.driver, configured: missing.length === 0, missing };
}

export async function loadEmailProvider(ctx: CoreContext): Promise<EmailProvider> {
  return new SettingsStore(ctx, SETTINGS).get("email_provider");
}

export async function loadEmailStatus(ctx: CoreContext): Promise<{ provider: EmailProvider; status: EmailStatus }> {
  const provider = await loadEmailProvider(ctx);
  return { provider, status: emailStatus(ctx.env, provider) };
}

/** Whether email can be sent right now. */
export async function isEmailConfigured(ctx: CoreContext): Promise<boolean> {
  return (await loadEmailStatus(ctx)).status.configured;
}

/** Magic links work: email configured and `magic_link_enabled` on (Identity §2; the engine's fact). */
export async function magicLinksAvailable(ctx: CoreContext): Promise<boolean> {
  if (!(await isEmailConfigured(ctx))) return false;
  return new SettingsStore(ctx, SETTINGS).get("magic_link_enabled");
}

export interface DriverDeps {
  fetch: Fetch;
  connect: SmtpConnect;
  now: () => number;
  /** The installation's canonical origin, for the test sink's loopback check. */
  canonicalOrigin: string | null;
}

export function defaultDriverDeps(canonicalOrigin: string | null): DriverDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    connect,
    now: Date.now,
    canonicalOrigin,
  };
}

/**
 * The driver for a configured provider, or null when email isn't configured. In a local e2e run
 * (`EMAIL_TEST_SINK=1` on a loopback origin) every driver becomes the sink.
 */
export function driverFor(env: Env, provider: EmailProvider, deps: DriverDeps): EmailDriver | null {
  if (!emailStatus(env, provider).configured) return null;
  if (sinkAllowed(env.EMAIL_TEST_SINK, deps.canonicalOrigin)) return sinkDriver(env.DB, deps.now);
  switch (provider.driver) {
    case "none":
      return null;
    case "cloudflare":
      return env.EMAIL ? cloudflareDriver(env.EMAIL) : null;
    case "resend":
      return resendDriver(env.RESEND_API_KEY ?? "", deps.fetch);
    case "postmark":
      return postmarkDriver(env.POSTMARK_SERVER_TOKEN ?? "", deps.fetch);
    case "ses":
      return sesDriver(
        {
          accessKeyId: env.SES_ACCESS_KEY_ID ?? "",
          secretAccessKey: env.SES_SECRET_ACCESS_KEY ?? "",
          region: provider.region,
        },
        deps.fetch,
        deps.now,
      );
    case "smtp":
      return smtpDriver(
        {
          host: provider.host,
          port: provider.port,
          security: provider.security,
          username: provider.username,
          password: env.SMTP_PASSWORD ?? "",
        },
        deps.connect,
        deps.now,
      );
  }
}
