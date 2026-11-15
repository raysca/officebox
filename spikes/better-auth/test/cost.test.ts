// Q12 cost: D1 work per authenticated request, and what a new per-installation instance does on first use.
// (Wall-clock timing isn't meaningful inside workerd tests; scripts/cost.mjs measures CPU time in Node.)
import { describe, expect, it } from "vitest";
import { queryLog, setQueryLogging } from "../src/d1-kysely";
import { createUser, signInWithMagicLink, testAuth, withStore } from "./helpers";

describe("Q12 per-request session read", () => {
  it("getSession (cookie cache off) is 2 SELECTs: session by token, then the user (no join support on SQLite path)", async () => {
    const { email } = await createUser();
    const { cookie } = await signInWithMagicLink(email);
    const auth = testAuth();
    await withStore(() => auth.api.getSession({ headers: new Headers({ cookie }) })); // warm: schema check runs once per instance
    setQueryLogging(true);
    const s = await withStore(() => auth.api.getSession({ headers: new Headers({ cookie }) }));
    const sqls = queryLog.map((q) => q.sql);
    setQueryLogging(false);
    expect(s?.user.email).toBe(email);
    console.log("getSession SQL:", JSON.stringify(sqls, null, 2));
    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toMatch(/from "sessions" where "sessions"\."token" = \?/);
    expect(sqls[1]).toMatch(/from "users" where "users"\."id" = \?/);
  });

  it("with advanced.database.joins: true it is a single SELECT with a join", async () => {
    const { email } = await createUser();
    const { cookie } = await signInWithMagicLink(email);
    const { buildAuthOptions } = await import("../src/auth");
    const { betterAuth } = await import("better-auth");
    const { env } = await import("cloudflare:workers");
    const { INST } = await import("./helpers");
    const o = buildAuthOptions(env, INST);
    const auth = betterAuth({ ...o, advanced: { ...o.advanced, database: { ...o.advanced.database, joins: true } } });
    await withStore(() => auth.api.getSession({ headers: new Headers({ cookie }) }));
    setQueryLogging(true);
    const s = await withStore(() => auth.api.getSession({ headers: new Headers({ cookie }) }));
    const sqls = queryLog.map((q) => q.sql);
    setQueryLogging(false);
    console.log("getSession SQL with joins:", JSON.stringify(sqls, null, 2));
    expect(s?.user.email).toBe(email);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toMatch(/join "users"/);
    // the joined user's dates still come back as valid Dates through the epoch-ms plugin
    expect(Number.isFinite(new Date(s!.user.createdAt).getTime())).toBe(true);
    expect(new Date(s!.user.createdAt).getUTCFullYear()).toBeGreaterThan(2000);
  });

  it("once a day per session (updateAge) the read adds one UPDATE and a refreshed Set-Cookie", async () => {
    const { userId, email } = await createUser();
    const { cookie } = await signInWithMagicLink(email);
    const { env } = await import("cloudflare:workers");
    // pretend the session was last refreshed 2 days ago
    await env.DB.prepare("UPDATE sessions SET expires_at = expires_at - ? WHERE user_id = ?").bind(2 * 86_400_000, userId).run();
    const auth = testAuth();
    await withStore(() => auth.api.getSession({ headers: new Headers({ cookie: "x=y" }) }));
    setQueryLogging(true);
    const out = await withStore(() => auth.api.getSession({ headers: new Headers({ cookie }), returnHeaders: true }));
    const sqls = queryLog.map((q) => q.sql);
    setQueryLogging(false);
    expect(sqls.filter((q) => q.startsWith("update"))).toHaveLength(1);
    expect(out.headers?.getSetCookie().some((c) => c.includes("session_token="))).toBe(true);
  });
});

describe("Q12 instance creation", () => {
  it("betterAuth() itself does no I/O; the first request on an instance runs the schema check (2 introspection queries)", async () => {
    setQueryLogging(true);
    const auth = testAuth();
    expect(queryLog).toHaveLength(0);
    await auth.$context;
    const afterInit = queryLog.length;
    await withStore(() => auth.api.getSession({ headers: new Headers({ cookie: "x=y" }) }));
    await withStore(() => auth.api.signInMagicLink({ body: { email: "warm@officebox.test" }, headers: new Headers() }));
    const sqls = queryLog.map((q) => q.sql);
    setQueryLogging(false);
    console.log("first-use SQL:", JSON.stringify(sqls, null, 2));
    expect(afterInit).toBe(0);
    expect(sqls.filter((q) => q.includes("sqlite_master")).length).toBe(2);
  });

  it("advanced.database.validateSchema: false skips the introspection", async () => {
    const { buildAuthOptions } = await import("../src/auth");
    const { betterAuth } = await import("better-auth");
    const { env } = await import("cloudflare:workers");
    const { INST } = await import("./helpers");
    const o = buildAuthOptions(env, INST);
    const auth = betterAuth({ ...o, advanced: { ...o.advanced, database: { ...o.advanced.database, validateSchema: false } } });
    setQueryLogging(true);
    await withStore(() => auth.api.signInMagicLink({ body: { email: "warm2@officebox.test" }, headers: new Headers() }));
    const sqls = queryLog.map((q) => q.sql);
    setQueryLogging(false);
    expect(sqls.filter((q) => q.includes("sqlite_master"))).toHaveLength(0);
  });
});
