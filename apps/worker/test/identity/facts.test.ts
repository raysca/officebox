import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/core/log";
import { authorize } from "../../src/core/permissions";
import { tokenHash } from "../../src/features/identity/crypto";
import { d1Facts, recoveryTokenUnconsumed } from "../../src/features/identity/facts";
import type { Env } from "../../src/env";
import { addMember, setupWorkspace, type Workspace } from "./helpers";

/** The permission engine on D1 facts (M1p `authorize`, Permissions §8): the loaders M1a wires. */

let ws: Workspace;
beforeAll(async () => {
  ws = await setupWorkspace();
});

const RECOVERY = "recovery-token-0123456789abcdefghijklmnopq";

describe("D1 fact loaders", () => {
  it("person, active owners and passkey counts come from D1", async () => {
    const facts = d1Facts(env);
    expect(await facts.person(ws.ownerId)).toEqual({ userId: ws.ownerId, role: "owner", status: "active" });
    expect(await facts.person("01JNOSUCHUSER0000000000000")).toBeNull();
    expect(await facts.activeOwnerCount()).toBe(1);
    expect(await facts.passkeyCount(ws.ownerId)).toBe(1);
    expect(await facts.magicLinksAvailable()).toBe(false);
    expect(await facts.groupManagerIds("01JNOGROUP0000000000000000")).toBeNull();
  });

  it("RECOVERY_TOKEN counts only when set (32+ characters) and not yet in recovery_token_uses", async () => {
    expect(await recoveryTokenUnconsumed(env)).toBe(false);
    const withToken = { ...env, RECOVERY_TOKEN: RECOVERY } as Env;
    expect(await recoveryTokenUnconsumed({ ...env, RECOVERY_TOKEN: "short" })).toBe(false);
    expect(await recoveryTokenUnconsumed(withToken)).toBe(true);
    await env.DB.prepare("INSERT INTO recovery_token_uses (token_hash, owner_id, used_at) VALUES (?, ?, ?)")
      .bind(await tokenHash(env.TOKEN_HASH_KEY!, RECOVERY), ws.ownerId, Date.now())
      .run();
    expect(await recoveryTokenUnconsumed(withToken)).toBe(false);
  });

  it("the owners' invite gate reads real facts: one passkey and no token is refused; a second passkey passes", async () => {
    const log = createLogger({}, () => {});
    const actor = { userId: ws.ownerId, role: "owner" as const, status: "active" as const, session: null };
    const ctx = { log, now: Date.now, actor, facts: d1Facts(env) };
    const refused = await authorize(ctx, { action: "invitation.create", role: "member" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.reason).toBe("owner_invite_gate");
    await env.DB.prepare(
      "INSERT INTO passkeys (id, user_id, credential_id, public_key, device_type, backed_up) VALUES ('01JSECONDPASSKEY0000000000', ?, 'cred-second', 'pk', 'singleDevice', 0)",
    )
      .bind(ws.ownerId)
      .run();
    expect((await authorize(ctx, { action: "invitation.create", role: "member" })).ok).toBe(true);
  });

  it("an admin can't act on an owner, through the same loaders", async () => {
    const admin = await addMember("admin");
    const log = createLogger({}, () => {});
    const ctx = {
      log,
      now: Date.now,
      actor: { userId: admin.id, role: "admin" as const, status: "active" as const, session: null },
      facts: d1Facts(env),
    };
    const result = await authorize(ctx, { action: "member.disable", targetId: ws.ownerId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("owner_required");
  });
});
