import {
  apiError,
  can,
  createInvitationBodySchema,
  err,
  ok,
  patchSettingBodySchema,
  sendTestEmailBodySchema,
  ulidSchema,
  type ApiError,
  type SettingsList,
} from "@officebox/shared";
import { Hono } from "hono";
import { auditStatement } from "../../core/audit";
import { defineFeature } from "../../core/app";
import { authOf, coreContext, type AppContext, type AppEnv } from "../../core/context";
import { Database, expectOk } from "../../core/db";
import { readJson, respond } from "../../core/errors";
import { authorize } from "../../core/permissions";
import { refundLimit, takeCounterLimit } from "../../core/rate-limit";
import { TEST_EMAIL_LIMIT } from "../email/limits";
import { SETTINGS, SettingsStore } from "../../core/settings";
import { loadEmailStatus } from "../email/config";
import { enqueueEmail } from "../email/delivery";
import { testEmail } from "../email/templates";
import { actorOf, permissionContext } from "../identity/facts";
import {
  copyInvitationLink,
  createInvitation,
  invitationRole,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from "../identity/invitations";
import { identityServices, requireAuth } from "../identity/middleware";

/**
 * The admin area's M1b endpoints (Admin §3, §6, §17; Platform §15; Identity §6), under `/api/admin`.
 * Every route asks the permission engine first; owner-only settings and admin invitations need an
 * owner; every change is audited.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /admin/settings` | Owner, admin (`admin.settings.view`); each key says whether the caller may change it |
 * | `PATCH /admin/settings` `{ key, value }` | Per key (Platform §7): `setting.change` with the key's `changeableBy` |
 * | `POST /admin/email/test` | Owner, admin (`admin.email.test`); to the caller's own address; audited |
 * | `GET /admin/invitations` | Owner, admin |
 * | `POST /admin/invitations` | `invitation.create` (admins: members; owners: admins too, with the invite gate) |
 * | `GET /admin/invitations/:id/link` · `POST …/:id/resend` | `invitation.create` for the invitation's role |
 * | `DELETE /admin/invitations/:id` | `invitation.revoke` for the invitation's role |
 */

const SMALL_BODY = 16 * 1024;
const NOT_FOUND: ApiError = apiError("not_found", "No such invitation.");

async function services(c: AppContext) {
  const result = await identityServices(c);
  if (!result.ok) throw new Error("identity services vanished after requireAuth");
  return result.value;
}

/** Loads a pending invitation's role after the fact-free check, so non-admins never learn it exists. */
async function roleFor(c: AppContext, id: string) {
  const me = authOf(c);
  const view = await authorize(permissionContext(c, me), { action: "admin.invitations.view" });
  if (!view.ok) return view;
  if (!ulidSchema.safeParse(id).success) return err(NOT_FOUND);
  const role = await invitationRole(coreContext(c), id);
  return role ? ok(role) : err(NOT_FOUND);
}

const adminRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/settings", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "admin.settings.view" });
    if (!allowed.ok) return respond(c, allowed);
    const ctx = coreContext(c);
    const entries = await new SettingsStore(ctx, SETTINGS).list();
    const actor = actorOf(me);
    const now = ctx.now();
    const { status } = await loadEmailStatus(ctx);
    const body: SettingsList = {
      settings: entries.map((entry) => ({
        ...entry,
        // An affordance only: PATCH asks the engine again.
        canChange: can(actor, { action: "setting.change", changeableBy: entry.changeableBy }, now),
      })),
      email: status,
    };
    return respond(c, ok(body));
  })
  .patch("/settings", async (c) => {
    const me = authOf(c);
    // The fact-free part first, so a member learns nothing about which keys exist.
    const view = await authorize(permissionContext(c, me), { action: "admin.settings.view" });
    if (!view.ok) return respond(c, view);
    const body = await readJson(c, patchSettingBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const definition = Object.hasOwn(SETTINGS, body.value.key)
      ? SETTINGS[body.value.key as keyof typeof SETTINGS]
      : undefined;
    if (!definition) return respond(c, err(apiError("not_found", "No such setting.")));
    const allowed = await authorize(permissionContext(c, me), {
      action: "setting.change",
      changeableBy: definition.changeableBy,
    });
    if (!allowed.ok) return respond(c, allowed);
    const result = await new SettingsStore(coreContext(c), SETTINGS).set(body.value.key, body.value.value, me.userId);
    return respond(c, result);
  })
  .post("/email/test", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "admin.email.test" });
    if (!allowed.ok) return respond(c, allowed);
    const body = await readJson(c, sendTestEmailBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    const ctx = coreContext(c);
    const { status } = await loadEmailStatus(ctx);
    if (!status.configured) {
      return respond(
        c,
        err(
          apiError("unavailable", "Email isn't set up yet. Choose a driver and a sender first.", {
            reason: "email_not_configured",
          }),
        ),
      );
    }
    const database = new Database(c.env.DB);
    const row = expectOk(
      await database.first<{ email: string | null }>("SELECT email FROM users WHERE id = ?", me.userId),
    );
    if (!row?.email) return respond(c, err(apiError("unauthenticated", "Sign in to continue.")));
    const { installation } = await services(c);
    const rendered = testEmail({ workspace: installation.workspaceName, driver: status.driver });
    // Counted only once email is configured, and given back if the queue refuses the email.
    const counted = await takeCounterLimit(ctx, TEST_EMAIL_LIMIT, me.userId);
    if (!counted.ok) return respond(c, counted);
    const queued = await enqueueEmail(ctx, { kind: "test", to: row.email, ...rendered });
    if (!queued.ok) {
      await refundLimit(ctx, counted.value);
      return respond(c, queued);
    }
    expectOk(
      await database.batchRun([
        await auditStatement(ctx, {
          action: "email.test_sent",
          actor: me.userId,
          target: { type: "email_delivery", id: queued.value },
          metadata: { driver: status.driver },
        }),
      ]),
    );
    return respond(c, ok({ to: row.email, jobId: queued.value }), 202);
  })
  .get("/invitations", async (c) => {
    const me = authOf(c);
    const allowed = await authorize(permissionContext(c, me), { action: "admin.invitations.view" });
    if (!allowed.ok) return respond(c, allowed);
    return respond(c, ok({ invitations: await listInvitations(coreContext(c)) }));
  })
  .post("/invitations", async (c) => {
    const me = authOf(c);
    const view = await authorize(permissionContext(c, me), { action: "admin.invitations.view" });
    if (!view.ok) return respond(c, view);
    const body = await readJson(c, createInvitationBodySchema, SMALL_BODY);
    if (!body.ok) return respond(c, body);
    // Admins invite members; only owners invite admins; owners meet the invite gate (Identity §2).
    const allowed = await authorize(permissionContext(c, me), { action: "invitation.create", role: body.value.role });
    if (!allowed.ok) return respond(c, allowed);
    const { secrets, installation } = await services(c);
    return respond(c, await createInvitation(coreContext(c), secrets, installation, me.userId, body.value), 201);
  })
  .get("/invitations/:id/link", async (c) => {
    const me = authOf(c);
    const role = await roleFor(c, c.req.param("id"));
    if (!role.ok) return respond(c, role);
    const allowed = await authorize(permissionContext(c, me), { action: "invitation.create", role: role.value });
    if (!allowed.ok) return respond(c, allowed);
    const { secrets, installation } = await services(c);
    return respond(c, await copyInvitationLink(coreContext(c), secrets, installation, c.req.param("id")));
  })
  .post("/invitations/:id/resend", async (c) => {
    const me = authOf(c);
    const role = await roleFor(c, c.req.param("id"));
    if (!role.ok) return respond(c, role);
    const allowed = await authorize(permissionContext(c, me), { action: "invitation.create", role: role.value });
    if (!allowed.ok) return respond(c, allowed);
    const { secrets, installation } = await services(c);
    return respond(c, await resendInvitation(coreContext(c), secrets, installation, me.userId, c.req.param("id")));
  })
  .delete("/invitations/:id", async (c) => {
    const me = authOf(c);
    const role = await roleFor(c, c.req.param("id"));
    if (!role.ok) return respond(c, role);
    const allowed = await authorize(permissionContext(c, me), { action: "invitation.revoke", role: role.value });
    if (!allowed.ok) return respond(c, allowed);
    return respond(c, await revokeInvitation(coreContext(c), me.userId, c.req.param("id")));
  });

export const adminFeature = defineFeature("admin", adminRoutes);
