import type { SecurityNoticeDetails, SecurityNoticeKind } from "@officebox/shared";
import type { CoreContext } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { isEmailConfigured } from "../email/config";
import { enqueueEmail } from "../email/delivery";
import { securityNoticeEmail } from "../email/templates";
import { loadInstallation } from "./installation";
import { currentStore } from "./request-store";

/**
 * Email delivery of security notices (Identity §4.6a; Notifications §3, §9 M1). Every notice added to
 * the banner list (`noticeStatement`) is also emailed **when email is configured**: passkey added, a
 * new-device magic-link sign-in, a clone detected. Security notices are never held by do-not-disturb
 * and can't be turned off (Notifications §5.1, §6), so nothing here checks preferences.
 *
 * Call it **after** the batch that appended the notices commits. It runs in the request's `waitUntil`
 * when there is one, so the email never delays (or fails) the response; failures are logged.
 */

export interface RaisedNotice {
  userId: string;
  kind: SecurityNoticeKind;
  details: SecurityNoticeDetails;
  at: number;
  /**
   * Send to this address instead of the person's current one: an email change notifies the **old**
   * address (Identity §4.11; Notifications §3).
   */
  to?: string;
}

async function deliver(ctx: CoreContext, notices: readonly RaisedNotice[]): Promise<void> {
  if (notices.length === 0 || !(await isEmailConfigured(ctx))) return;
  const installation = await loadInstallation(ctx.env.DB);
  if (!installation?.canonicalOrigin) return;
  const database = new Database(ctx.env.DB);
  for (const notice of notices) {
    const user = expectOk(
      await database.first<{ email: string | null; status: string }>(
        "SELECT email, status FROM users WHERE id = ?",
        notice.userId,
      ),
    );
    // Disabled, deleted and reserved rows get no email (Platform §3).
    if (!user?.email || user.status !== "active") continue;
    const rendered = securityNoticeEmail({
      workspace: installation.workspaceName,
      kind: notice.kind,
      details: notice.details,
      at: notice.at,
      signInUrl: new URL("/sign-in", installation.canonicalOrigin).toString(),
    });
    const queued = await enqueueEmail(ctx, { kind: "security_notice", to: notice.to ?? user.email, ...rendered });
    if (!queued.ok) ctx.log.warn("security notice email not queued", { userId: notice.userId, kind: notice.kind });
  }
}

export function emailSecurityNotices(ctx: CoreContext, notices: readonly RaisedNotice[]): Promise<void> {
  const work = deliver(ctx, notices).catch((error: unknown) => {
    ctx.log.error("security notice email failed", { error });
  });
  const waitUntil = currentStore()?.waitUntil;
  if (waitUntil) {
    waitUntil(work);
    return Promise.resolve();
  }
  return work;
}
