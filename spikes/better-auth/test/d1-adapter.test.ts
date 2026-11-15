// Q1 D1 adapter: env.DB in workerd, our table and field names with ULIDs, date storage, and no transactions.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { requestStore } from "../src/context";
import { testAuth, uniqueEmail, withCreateMarker, withStore } from "./helpers";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

async function columnTypes(table: string, id: string, cols: string[]): Promise<Record<string, string>> {
  const sel = cols.map((c) => `typeof(${c}) AS ${c}`).join(", ");
  return (await env.DB.prepare(`SELECT ${sel} FROM ${table} WHERE id = ?`).bind(id).first<Record<string, string>>())!;
}

describe("Q1 D1 adapter", () => {
  it("database: env.DB works in workerd (better-auth's built-in D1 detection), with our names and ULIDs", async () => {
    const auth = testAuth({ db: "binding" });
    const ctx = await auth.$context;
    const email = uniqueEmail("binding");
    const user = await withCreateMarker(() => ctx.internalAdapter.createUser({ email, name: "Binding User", emailVerified: true }, { method: "test" }));
    expect(user.id).toMatch(ULID);
    const row = await env.DB.prepare("SELECT id, display_name, email, email_verified, role, status, email_normalised FROM users WHERE id = ?").bind(user.id).first();
    expect(row).toMatchObject({ display_name: "Binding User", email, email_verified: 1, role: "member", status: "active", email_normalised: email });
    const session = await withStore(() => ctx.internalAdapter.createSession(user.id));
    expect(session.id).toMatch(ULID);
    expect((await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?").bind(session.id).first())?.user_id).toBe(user.id);
  });

  it("with env.DB (and with our Kysely without the plugin) dates are ISO-8601 TEXT, even in INTEGER columns", async () => {
    for (const db of ["binding", "kysely-iso"] as const) {
      const ctx = await testAuth({ db }).$context;
      const user = await withCreateMarker(() => ctx.internalAdapter.createUser({ email: uniqueEmail(db), name: "x", emailVerified: true }, { method: "test" }));
      const session = await withStore(() => ctx.internalAdapter.createSession(user.id));
      expect(await columnTypes("users", user.id, ["created_at", "updated_at"])).toEqual({ created_at: "text", updated_at: "text" });
      expect(await columnTypes("sessions", session.id, ["expires_at", "created_at"])).toEqual({ expires_at: "text", created_at: "text" });
      const raw = await env.DB.prepare("SELECT expires_at FROM sessions WHERE id = ?").bind(session.id).first<{ expires_at: string }>();
      expect(raw?.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it("with the EpochMsPlugin dates are INTEGER epoch ms, and better-auth still reads them as Dates", async () => {
    const auth = testAuth({ db: "kysely-epoch" });
    const ctx = await auth.$context;
    const user = await withCreateMarker(() => ctx.internalAdapter.createUser({ email: uniqueEmail("epoch"), name: "x", emailVerified: true }, { method: "test" }));
    expect(user.createdAt).toBeInstanceOf(Date);
    const session = await withStore(() => ctx.internalAdapter.createSession(user.id));
    expect(await columnTypes("users", user.id, ["created_at", "updated_at"])).toEqual({ created_at: "integer", updated_at: "integer" });
    expect(await columnTypes("sessions", session.id, ["expires_at", "created_at", "updated_at"])).toEqual({ expires_at: "integer", created_at: "integer", updated_at: "integer" });
    const raw = await env.DB.prepare("SELECT expires_at, created_at FROM sessions WHERE id = ?").bind(session.id).first<{ expires_at: number; created_at: number }>();
    expect(raw!.expires_at - raw!.created_at).toBe(30 * 24 * 3600 * 1000);
    // Reading back: findSession returns Date objects and the session is valid
    const found = await withStore(() => ctx.internalAdapter.findSession(session.token));
    expect(found?.session.expiresAt).toBeInstanceOf(Date);
    expect(found?.session.expiresAt.getTime()).toBe(raw!.expires_at);
    // Where clauses on dates compare numbers: findVerificationValue's cleanup (`expires_at < now`) deletes the
    // expired row and keeps the live one. (findVerificationValue itself doesn't check expiry; its callers do.)
    await withStore(() =>
      ctx.internalAdapter.createVerificationValue({ identifier: `exp-${user.id}`, value: "v", expiresAt: new Date(Date.now() - 1000) }),
    );
    await withStore(() => ctx.internalAdapter.createVerificationValue({ identifier: `live-${user.id}`, value: "v", expiresAt: new Date(Date.now() + 60_000) }));
    expect((await withStore(() => ctx.internalAdapter.findVerificationValue(`live-${user.id}`)))?.value).toBe("v");
    const left = await env.DB.prepare("SELECT identifier FROM auth_verifications WHERE identifier IN (?, ?)").bind(`exp-${user.id}`, `live-${user.id}`).all();
    expect(left.results).toEqual([{ identifier: `live-${user.id}` }]);
    // Updates (sliding expiry) write numbers too
    await withStore(() => ctx.internalAdapter.updateSession(session.token, { expiresAt: new Date(Date.now() + 1000) }));
    expect(await columnTypes("sessions", session.id, ["expires_at"])).toEqual({ expires_at: "integer" });
  });

  it("an ISO-looking string in a non-date column is left alone", async () => {
    const ctx = await testAuth().$context;
    const iso = new Date().toISOString();
    const user = await withCreateMarker(() => ctx.internalAdapter.createUser({ email: uniqueEmail("iso"), name: iso, emailVerified: true }, { method: "test" }));
    const row = await env.DB.prepare("SELECT display_name, typeof(display_name) AS t FROM users WHERE id = ?").bind(user.id).first();
    expect(row).toEqual({ display_name: iso, t: "text" });
  });

  it("no transactions: a multi-step better-auth write is not rolled back (createOAuthUser leaves the user when the account insert fails)", async () => {
    const ctx = await testAuth().$context;
    const email = uniqueEmail("notx");
    await expect(
      withCreateMarker(() =>
        ctx.internalAdapter.createOAuthUser(
          { email, name: "No Tx", emailVerified: true },
          // provider_id is NOT NULL in auth_accounts: this insert fails after the user insert succeeded
          { accountId: "acc", providerId: null as unknown as string },
        ),
      ),
    ).rejects.toThrow();
    const left = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE email = ?").bind(email).first<{ n: number }>();
    expect(left?.n).toBe(1); // in a transaction this would be 0
  });

  it("no transactions: verification consume is still atomic (one DELETE … RETURNING), ten concurrent consumers get one row", async () => {
    const ctx = await testAuth().$context;
    const identifier = `race-${crypto.randomUUID()}`;
    await withStore(() => ctx.internalAdapter.createVerificationValue({ identifier, value: "once", expiresAt: new Date(Date.now() + 60_000) }));
    const got = await Promise.all(Array.from({ length: 10 }, () => requestStore.run({}, () => ctx.internalAdapter.consumeVerificationValue(identifier))));
    expect(got.filter(Boolean)).toHaveLength(1);
  });
});
