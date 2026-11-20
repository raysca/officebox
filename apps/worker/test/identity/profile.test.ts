import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  DEFAULT_WORKING_HOURS,
  FILE_CONTENT_SECURITY_POLICY,
  HANDLE_HOLD_MS,
  MAX_AVATAR_BYTES,
  type DirectoryPage,
  type HandleAvailability,
  type MemberProfile,
  type MyProfile,
} from "@officebox/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { ulid } from "../../src/core/ids";
import { openHub } from "./m1c-helpers";
import {
  acceptInvite,
  addMember,
  Browser,
  callWorker,
  claim,
  fragmentToken,
  invite,
  meetInviteGate,
  ORIGIN,
  ownerDetails,
  resetInstallation,
  seedSetupToken,
  setupWorkspace,
  uniqueEmail,
  uniqueHandle,
  type Workspace,
} from "./helpers";
import { concat, contains, GIF, HTML, jpeg, jpegWithMetadata, png, PNG_1X1, SVG, text, webp } from "./images";

/**
 * M1d: profiles, status, avatars, @handles and the member directory (Identity §4.7, §4.8, §4.10, §6, §9;
 * Permissions §4.6; Platform §8; TDD §8.3). One workspace for the file; every test makes its own members
 * and unique names, since storage is shared between tests in a file (AGENTS §5).
 */

type Member = Awaited<ReturnType<typeof addMember>>;

let ws: Workspace;
let butlerAtSetup: { status: number; body: { error?: { code: string; reason?: string } } };

beforeAll(async () => {
  // Before the workspace exists: the assistant's derived handle can't be the owner's (Identity §4.8).
  await resetInstallation();
  await seedSetupToken();
  butlerAtSetup = await claim(new Browser(), { ...ownerDetails(), handle: "butler" });
  ws = await setupWorkspace();
});

/** Moves a UserHub's test clock forward and its timers' due times back by `ms` (no wall-clock sleep). */
async function advanceHubClock(userId: string, ms: number): Promise<void> {
  await runInDurableObject(env.USER_HUB.getByName(userId), (_instance, state) => {
    const current = Number(
      state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'test_time_offset_ms'").toArray()[0]
        ?.value ?? "0",
    );
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('test_time_offset_ms', ?)",
      String(current + ms),
    );
    state.storage.sql.exec("UPDATE core_timers SET due_at = due_at - ?", ms);
  });
}

/** A raw-body request (avatar uploads) from a signed-in browser, with the CSRF header and Origin. */
async function upload(browser: Browser, bytes: Uint8Array, contentType: string, headers: Record<string, string> = {}) {
  const response = await callWorker(
    new Request(`${ORIGIN}/api/me/avatar`, {
      method: "PUT",
      headers: {
        "cf-connecting-ip": browser.ip,
        "x-officebox-request": "1",
        origin: ORIGIN,
        "content-type": contentType,
        cookie: browser.cookieHeader(),
        ...headers,
      },
      body: bytes,
    }),
  );
  const raw = await response.text();
  return {
    status: response.status,
    body: (raw ? JSON.parse(raw) : null) as { avatarUrl?: string | null; error?: { code: string; reason?: string } },
  };
}

/** A GET for a binary response, without the text copy `Browser.call` keeps. */
function getFile(browser: Browser, path: string) {
  return callWorker(
    new Request(`${ORIGIN}${path}`, { headers: { "cf-connecting-ip": browser.ip, cookie: browser.cookieHeader() } }),
  );
}

async function avatarKey(userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT avatar_key FROM users WHERE id = ?").bind(userId).first<{
    avatar_key: string | null;
  }>();
  return row?.avatar_key ?? null;
}

async function setProfile(member: Member, fields: Record<string, unknown>) {
  return member.browser.json<
    MyProfile & { error?: { code: string; reason?: string; fields?: Record<string, string[]> } }
  >("/api/me/profile", { method: "PATCH", body: fields });
}

async function directory(browser: Browser, query = "") {
  return browser.json<DirectoryPage & { error?: { code: string } }>(`/api/members${query}`);
}

async function insertUser(status: "disabled" | "deleted", name = `Gone ${ulid()}`): Promise<string> {
  const id = ulid();
  const now = Date.now();
  const email = status === "deleted" ? null : uniqueEmail(status);
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_normalised, display_name, handle, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'member', ?, ?, ?)`,
  )
    .bind(id, email, email, name, status === "deleted" ? null : uniqueHandle("x"), status, now, now)
    .run();
  return id;
}

describe("own profile (Identity §4.7)", () => {
  it("starts with the defaults: UTC, Mon–Fri 09:00–17:00, no region", async () => {
    const member = await addMember();
    const res = await member.browser.json<MyProfile>("/api/me/profile");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: member.id,
      email: member.email,
      timezone: "UTC",
      workingHours: DEFAULT_WORKING_HOURS,
      workingHoursDefaulted: true,
      region: null,
      status: null,
      avatarUrl: null,
      deactivated: false,
      groups: [],
      handleChangesLeft: 3,
      onboardedAt: null,
    });
  });

  it("saves every field and shows it in GET /me, the directory and the profile card", async () => {
    const member = await addMember();
    const res = await setProfile(member, {
      displayName: "Robin Okafor",
      timezone: "Europe/Berlin",
      workingHours: {
        mon: [
          ["08:00", "12:00"],
          ["13:00", "16:00"],
        ],
        fri: [["08:00", "12:00"]],
      },
      region: "de-by",
      jobTitle: "Designer",
      team: "Brand",
      pronouns: "they/them",
      phone: "+49 30 1234567",
      location: "Berlin office",
      onboarded: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      displayName: "Robin Okafor",
      timezone: "Europe/Berlin",
      region: "DE-BY",
      jobTitle: "Designer",
      workingHoursDefaulted: false,
      workingHours: {
        mon: [
          ["08:00", "12:00"],
          ["13:00", "16:00"],
        ],
        tue: [],
        fri: [["08:00", "12:00"]],
        sun: [],
      },
    });
    expect(res.body.onboardedAt).toBeTypeOf("number");

    const me = await member.browser.json<{ user: { displayName: string; timezone: string } }>("/api/me");
    expect(me.body.user).toMatchObject({ displayName: "Robin Okafor", timezone: "Europe/Berlin" });

    const card = await ws.browser.json<MemberProfile>(`/api/members/${member.id}`);
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ pronouns: "they/them", phone: "+49 30 1234567", location: "Berlin office" });
    expect(card.body).not.toHaveProperty("handleChangesLeft");
  });

  it("clears optional fields with null or an empty string", async () => {
    const member = await addMember();
    await setProfile(member, { jobTitle: "Lead", team: "Ops" });
    const res = await setProfile(member, { jobTitle: "", team: null });
    expect(res.body).toMatchObject({ jobTitle: null, team: null });
  });

  it.each([
    [{ timezone: "Mars/Olympus" }, "timezone"],
    [{ timezone: "+05:00" }, "timezone"],
    [{ region: "XX" }, "region"],
    [{ workingHours: { mon: [["17:00", "09:00"]] } }, "workingHours.mon.0"],
    [{ displayName: "" }, "displayName"],
    [{ displayName: "x".repeat(65) }, "displayName"],
    [{ jobTitle: "x".repeat(101) }, "jobTitle"],
  ])("refuses %j", async (fields, field) => {
    const member = await addMember();
    const res = await setProfile(member, fields);
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("validation_failed");
    expect(Object.keys(res.body.error?.fields ?? {})).toContain(field);
  });

  it("refuses fields a member can't set here (email, role, status, avatar key)", async () => {
    const member = await addMember();
    for (const field of [{ email: uniqueEmail() }, { role: "owner" }, { status: "active" }, { avatarKey: "x" }]) {
      const res = await setProfile(member, field);
      expect(res.status).toBe(400);
    }
    const row = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(member.id).first<{ role: string }>();
    expect(row?.role).toBe("member");
  });

  it("nobody edits someone else's profile, an owner included: there is no such route", async () => {
    const member = await addMember();
    for (const method of ["PATCH", "PUT", "POST"]) {
      const res = await ws.browser.json(`/api/members/${member.id}`, { method, body: { displayName: "Hijacked" } });
      expect(res.status).toBe(404);
    }
    const res = await ws.browser.json(`/api/members/${member.id}/avatar`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const row = await env.DB.prepare("SELECT display_name FROM users WHERE id = ?")
      .bind(member.id)
      .first<{ display_name: string }>();
    expect(row?.display_name).not.toBe("Hijacked");
  });

  it("needs a session and the CSRF header", async () => {
    const anonymous = new Browser();
    expect((await anonymous.json("/api/me/profile")).status).toBe(401);
    expect((await anonymous.json("/api/members")).status).toBe(401);
    const member = await addMember();
    const res = await member.browser.json("/api/me/profile", {
      method: "PATCH",
      body: { jobTitle: "x" },
      noCsrf: true,
    });
    expect(res.status).toBe(403);
  });

  it("stores the canonical spelling of a time zone", async () => {
    const member = await addMember();
    expect((await setProfile(member, { timezone: "europe/berlin" })).body.timezone).toBe("Europe/Berlin");
    expect((await setProfile(member, { timezone: "utc" })).body.timezone).toBe("UTC");
  });

  it("PATCH /me/preferences follows the same time zone rule and records the update", async () => {
    const member = await addMember();
    const refused = await member.browser.json("/api/me/preferences", { method: "PATCH", body: { timezone: "+05:00" } });
    expect(refused.status).toBe(400);
    const before = Date.now();
    const res = await member.browser.json<{ timezone: string }>("/api/me/preferences", {
      method: "PATCH",
      body: { timezone: "asia/tokyo" },
    });
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("Asia/Tokyo");
    const row = await env.DB.prepare("SELECT timezone, updated_at FROM users WHERE id = ?")
      .bind(member.id)
      .first<{ timezone: string; updated_at: number }>();
    expect(row).toMatchObject({ timezone: "Asia/Tokyo" });
    expect(row!.updated_at).toBeGreaterThanOrEqual(before);
    // A disabled member can't change it.
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member.id).run();
    const disabled = await member.browser.json("/api/me/preferences", { method: "PATCH", body: { timezone: "UTC" } });
    expect(disabled.status).toBe(401);
  });

  it("a time zone change recomputes availability without failing", async () => {
    const member = await addMember();
    const res = await setProfile(member, { timezone: "America/New_York" });
    expect(res.status).toBe(200);
    const availability = await ws.browser.json<{ availability: { state: string } }>(
      `/api/members/${member.id}/availability`,
    );
    expect(availability.status).toBe(200);
  });
});

describe("status (Identity §4.7)", () => {
  it("sets, shows and clears a status", async () => {
    const member = await addMember();
    const expiresAt = Date.now() + 60 * 60_000;
    const set = await member.browser.json<{ status: unknown }>("/api/me/status", {
      method: "PUT",
      body: { emoji: "📅", text: "In a meeting", expiresAt },
    });
    expect(set.status).toBe(200);
    expect(set.body.status).toEqual({ emoji: "📅", text: "In a meeting", expiresAt });
    const card = await ws.browser.json<MemberProfile>(`/api/members/${member.id}`);
    expect(card.body.status).toEqual({ emoji: "📅", text: "In a meeting", expiresAt });

    const cleared = await member.browser.json<{ status: unknown }>("/api/me/status", { method: "DELETE" });
    expect(cleared.body.status).toBeNull();
    expect((await ws.browser.json<MemberProfile>(`/api/members/${member.id}`)).body.status).toBeNull();
  });

  it("hides a status once its expiry passes", async () => {
    const member = await addMember();
    await member.browser.json("/api/me/status", {
      method: "PUT",
      body: { emoji: "🌴", text: "Away", expiresAt: null },
    });
    await env.DB.prepare("UPDATE users SET status_expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, member.id)
      .run();
    expect((await ws.browser.json<MemberProfile>(`/api/members/${member.id}`)).body.status).toBeNull();
  });

  it.each([
    [{ emoji: "🌴🌴", text: null, expiresAt: null }, "two emoji"],
    [{ emoji: "x", text: null, expiresAt: null }, "a letter"],
    [{ emoji: null, text: "x".repeat(101), expiresAt: null }, "long text"],
    [{ emoji: null, text: "Back soon", expiresAt: 1 }, "an expiry in the past"],
    [{ emoji: null, text: "Back soon", expiresAt: Date.now() + 400 * 24 * 3600_000 }, "more than a year ahead"],
  ] as [Record<string, unknown>, string][])("refuses %j (%s)", async (body) => {
    const member = await addMember();
    const res = await member.browser.json("/api/me/status", { method: "PUT", body });
    expect(res.status).toBe(400);
  });

  it("reaches live presence, and its expiry clears it there (UserHub status_expiry timer)", async () => {
    const member = await addMember();
    const hub = await openHub(member.browser);
    expect(hub).not.toBeNull();
    const presenceOf = async () => {
      const res = await ws.browser.json<{ online: { userId: string; statusText: string | null }[] }>(
        "/api/realtime/presence",
      );
      return res.body.online.find((entry) => entry.userId === member.id);
    };
    await expect.poll(presenceOf).toBeTruthy();

    const expiresAt = Date.now() + 10 * 60_000;
    await member.browser.json("/api/me/status", { method: "PUT", body: { emoji: "☕", text: "Coffee", expiresAt } });
    expect((await presenceOf())?.statusText).toBe("☕ Coffee");

    // Injected clock: the hub's time moves past the expiry and its status timer comes due.
    await advanceHubClock(member.id, 10 * 60_000 + 1000);
    await runDurableObjectAlarm(env.USER_HUB.getByName(member.id));
    expect((await presenceOf())?.statusText).toBeNull();
  });

  it("the hub reconciles a status it was never told about on its heartbeat", async () => {
    const member = await addMember();
    const hub = await openHub(member.browser);
    expect(hub).not.toBeNull();
    const presenceOf = async () => {
      const res = await ws.browser.json<{ online: { userId: string; statusText: string | null }[] }>(
        "/api/realtime/presence",
      );
      return res.body.online.find((entry) => entry.userId === member.id);
    };
    await expect.poll(presenceOf).toBeTruthy();
    // Written straight to D1, as if the Worker's refreshStatus calls had all failed.
    await env.DB.prepare("UPDATE users SET status_emoji = '🚲', status_text = 'Cycling' WHERE id = ?")
      .bind(member.id)
      .run();
    expect((await presenceOf())?.statusText).toBeNull();
    await advanceHubClock(member.id, 5 * 60_000 + 1000);
    await runDurableObjectAlarm(env.USER_HUB.getByName(member.id));
    expect((await presenceOf())?.statusText).toBe("🚲 Cycling");
  });
});

describe("@handles (Identity §4.8, Platform §8)", () => {
  it("changes a handle, keeping the copy on users in step, and holds the old one for 30 days", async () => {
    const member = await addMember();
    const first = uniqueHandle("first");
    expect((await setProfile(member, { handle: first })).status).toBe(200);
    const second = uniqueHandle("second");
    const res = await setProfile(member, { handle: `@${second.toUpperCase()}` });
    expect(res.status).toBe(200);
    expect(res.body.handle).toBe(second);
    const rows = await env.DB.prepare("SELECT handle, released_at FROM handles WHERE owner_id = ? ORDER BY handle")
      .bind(member.id)
      .all<{ handle: string; released_at: number | null }>();
    expect(rows.results.find((r) => r.handle === first)?.released_at).toBeTypeOf("number");
    expect(rows.results.find((r) => r.handle === second)?.released_at).toBeNull();

    // Someone else can't take the released handle during the hold.
    const other = await addMember();
    const taken = await setProfile(other, { handle: first });
    expect(taken.status).toBe(409);
    expect(taken.body.error?.reason).toBe("handle_held");
    const check = await other.browser.json<HandleAvailability>(`/api/handles/${first}/available`);
    expect(check.body).toMatchObject({ available: false, reason: "held" });

    // ...but its owner can take it back at once (default).
    expect((await setProfile(member, { handle: first })).body.handle).toBe(first);
  });

  it("frees a released handle once its 30 days have passed", async () => {
    const member = await addMember();
    const old = uniqueHandle("old");
    await setProfile(member, { handle: old });
    await setProfile(member, { handle: uniqueHandle("new") });
    await env.DB.prepare("UPDATE handles SET released_at = ? WHERE handle = ?")
      .bind(Date.now() - HANDLE_HOLD_MS - 1000, old)
      .run();
    const other = await addMember();
    const res = await setProfile(other, { handle: old });
    expect(res.status).toBe(200);
    expect(res.body.handle).toBe(old);
  });

  it("refuses a handle someone else has, ignoring case, and one a group would share (one namespace)", async () => {
    const owner = await addMember();
    const handle = uniqueHandle("dup");
    await setProfile(owner, { handle });
    const other = await addMember();
    const res = await setProfile(other, { handle: handle.toUpperCase() });
    expect(res.status).toBe(409);
    expect(res.body.error?.reason).toBe("handle_taken");
    // A group's handle (groups arrive in M1e) lives in the same table.
    const groupHandle = uniqueHandle("grp");
    await env.DB.prepare("INSERT INTO handles (handle, owner_type, owner_id) VALUES (?, 'group', ?)")
      .bind(groupHandle, ulid())
      .run();
    expect((await setProfile(other, { handle: groupHandle })).body.error?.reason).toBe("handle_taken");
  });

  it.each(["everyone", "assistant", "admin", "here", "butler"])("refuses the reserved handle %s", async (handle) => {
    const member = await addMember();
    const res = await setProfile(member, { handle });
    expect(res.status).toBe(400);
    expect(res.body.error?.reason).toBe("handle_reserved");
  });

  it.each(["a", "-dash", "has space", "x".repeat(33), "ünï"])("refuses the malformed handle %j", async (handle) => {
    const member = await addMember();
    const res = await setProfile(member, { handle });
    expect(res.status).toBe(400);
    expect(res.body.error?.reason).toBe("handle_invalid");
  });

  it("refused setup with the assistant's derived handle as the owner's", () => {
    expect(butlerAtSetup.status).toBe(400);
    expect(butlerAtSetup.body.error?.reason).toBe("handle_reserved");
  });

  it("counts switching back and forth (A → B → A → B) against the limit", async () => {
    const member = await addMember();
    const [a, b] = [uniqueHandle("ha"), uniqueHandle("hb")];
    expect((await setProfile(member, { handle: a })).status).toBe(200); // a first handle isn't a change
    for (const handle of [b, a, b]) expect((await setProfile(member, { handle })).status).toBe(200);
    const res = await setProfile(member, { handle: a });
    expect(res.status).toBe(429);
    expect(res.body.error?.reason).toBe("handle_change_limit");
  });

  it("a failed handle change saves nothing else and uses up no change", async () => {
    const owner = await addMember();
    const taken = uniqueHandle("tk");
    await setProfile(owner, { handle: taken });
    const member = await addMember();
    await setProfile(member, { handle: uniqueHandle("mine") });
    const res = await setProfile(member, { handle: taken, jobTitle: "Should not save" });
    expect(res.status).toBe(409);
    const profile = await member.browser.json<MyProfile>("/api/me/profile");
    expect(profile.body.jobTitle).toBeNull();
    expect(profile.body.handleChangesLeft).toBe(3);
  });

  it("a handle change and other fields save together", async () => {
    const member = await addMember();
    await setProfile(member, { handle: uniqueHandle("one") });
    const next = uniqueHandle("two");
    const res = await setProfile(member, { handle: next, jobTitle: "Together" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handle: next, jobTitle: "Together", handleChangesLeft: 2 });
  });

  it("allows three changes in 30 days, then answers rate_limited with a retry time", async () => {
    const member = await addMember();
    for (let i = 0; i < 4; i++) {
      const res = await setProfile(member, { handle: uniqueHandle(`r${i}`) });
      // The first claim (no handle before) releases nothing; the next three each release one.
      expect(res.status).toBe(200);
    }
    const profile = await member.browser.json<MyProfile>("/api/me/profile");
    expect(profile.body.handleChangesLeft).toBe(0);
    const res = await member.browser.json<{ error: { code: string; retryAfterSeconds?: number } }>("/api/me/profile", {
      method: "PATCH",
      body: { handle: uniqueHandle("r9") },
    });
    expect(res.status).toBe(429);
    expect(res.body.error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("a race for one handle between two members lets exactly one win", async () => {
    const [a, b] = await Promise.all([addMember(), addMember()]);
    const handle = uniqueHandle("race");
    const results = await Promise.all([setProfile(a, { handle }), setProfile(b, { handle })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const owners = await env.DB.prepare("SELECT owner_id FROM handles WHERE handle = ?").bind(handle).all();
    expect(owners.results).toHaveLength(1);
    const copies = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE handle = ?").bind(handle).first<{
      n: number;
    }>();
    expect(copies?.n).toBe(1);
  });

  it("two concurrent changes by one member leave one claimed handle, matching users.handle", async () => {
    const member = await addMember();
    await setProfile(member, { handle: uniqueHandle("base") });
    const [x, y] = [uniqueHandle("x"), uniqueHandle("y")];
    await Promise.all([setProfile(member, { handle: x }), setProfile(member, { handle: y })]);
    const live = await env.DB.prepare(
      "SELECT handle FROM handles WHERE owner_id = ? AND owner_type = 'user' AND released_at IS NULL",
    )
      .bind(member.id)
      .all<{ handle: string }>();
    expect(live.results).toHaveLength(1);
    const row = await env.DB.prepare("SELECT handle FROM users WHERE id = ?")
      .bind(member.id)
      .first<{ handle: string }>();
    expect(row?.handle).toBe(live.results[0]?.handle);
  });

  it("the availability check answers for free, own, taken and invalid handles", async () => {
    const member = await addMember();
    const mine = uniqueHandle("mine");
    await setProfile(member, { handle: mine });
    const ask = async (h: string) =>
      (await member.browser.json<HandleAvailability>(`/api/handles/${h}/available`)).body;
    expect(await ask(uniqueHandle("free"))).toMatchObject({ available: true, yours: false });
    expect(await ask(mine)).toMatchObject({ available: true, yours: true });
    expect(await ask(ws.owner.handle)).toMatchObject({ available: false, reason: "taken" });
    expect(await ask("x")).toMatchObject({ available: false, reason: "invalid" });
    expect(await ask("butler")).toMatchObject({ available: false, reason: "reserved" });
    expect((await new Browser().json(`/api/handles/${mine}/available`)).status).toBe(401);
  });

  it("an invitation can't be accepted with a held handle", async () => {
    await meetInviteGate(ws);
    const member = await addMember();
    const held = uniqueHandle("held");
    await setProfile(member, { handle: held });
    await setProfile(member, { handle: uniqueHandle("moved") });
    const created = await invite(ws.browser, uniqueEmail("invitee"));
    expect(created.status).toBe(201);
    const { accept } = await acceptInvite(fragmentToken(created.body.link)!, "Ana Diaz", held);
    expect(accept.status).toBe(409);
    expect((accept.body as unknown as { error: { reason: string } }).error.reason).toBe("handle_held");
  });
});

describe("avatars (Identity §4.7, TDD §8.3)", () => {
  it.each([
    ["PNG", PNG_1X1, "image/png", "png"],
    ["JPEG", jpeg(64, 64), "image/jpeg", "jpg"],
    ["WebP", webp(64, 64), "image/webp", "webp"],
  ] as const)("stores a %s and serves it safely to another member", async (_name, bytes, type, ext) => {
    const member = await addMember();
    const res = await upload(member.browser, bytes, type);
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toMatch(new RegExp(`^/api/members/${member.id}/avatar\\?v=[0-9A-Z]{26}$`));
    expect(await avatarKey(member.id)).toMatch(new RegExp(`^avatars/${member.id}/[0-9A-Z]{26}\\.${ext}$`));

    const served = await getFile(ws.browser, res.body.avatarUrl!);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe(type);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe(FILE_CONTENT_SECURITY_POLICY);
    expect(served.headers.get("content-disposition")).toBe(`inline; filename="avatar.${ext}"`);
    expect(served.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(served.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);

    const card = await ws.browser.json<MemberProfile>(`/api/members/${member.id}`);
    expect(card.body.avatarUrl).toBe(res.body.avatarUrl);
  });

  it("replacing an avatar deletes the old object; removing it goes back to initials", async () => {
    const member = await addMember();
    await upload(member.browser, PNG_1X1, "image/png");
    const firstKey = (await avatarKey(member.id))!;
    await upload(member.browser, jpeg(8, 8), "image/jpeg");
    const secondKey = (await avatarKey(member.id))!;
    expect(secondKey).not.toBe(firstKey);
    expect(await env.FILES.head(firstKey)).toBeNull();
    expect(await env.FILES.head(secondKey)).not.toBeNull();

    const removed = await member.browser.json<{ avatarUrl: null }>("/api/me/avatar", { method: "DELETE" });
    expect(removed.body.avatarUrl).toBeNull();
    expect(await avatarKey(member.id)).toBeNull();
    expect(await env.FILES.head(secondKey)).toBeNull();
    expect((await ws.browser.json(`/api/members/${member.id}/avatar`)).status).toBe(404);
  });

  it.each([
    ["an SVG with script", SVG, "image/svg+xml", "avatar_type"],
    ["an SVG sent as PNG", SVG, "image/png", "avatar_type"],
    ["HTML sent as PNG", HTML, "image/png", "avatar_type"],
    ["a GIF", GIF, "image/gif", "avatar_type"],
    ["a GIF sent as PNG", GIF, "image/png", "avatar_type"],
    ["a PNG sent as WebP", PNG_1X1, "image/webp", "avatar_type"],
    ["a PNG with no content type", PNG_1X1, "", "avatar_type"],
    ["a PNG + HTML polyglot", concat(PNG_1X1, HTML), "image/png", "avatar_malformed"],
    ["a JPEG + ZIP polyglot", concat(jpeg(4, 4), text("PK\u0003\u0004")), "image/jpeg", "avatar_malformed"],
    ["a WebP + script polyglot", concat(webp(4, 4), HTML), "image/webp", "avatar_malformed"],
    ["a truncated PNG", PNG_1X1.slice(0, 40), "image/png", "avatar_malformed"],
    ["a 5000-pixel-wide PNG", png(5000, 10), "image/png", "avatar_dimensions"],
  ])("refuses %s", async (_name, bytes, type, reason) => {
    const member = await addMember();
    const res = await upload(member.browser, bytes, type);
    expect(res.status).toBe(400);
    expect(res.body.error?.reason).toBe(reason);
    expect(await avatarKey(member.id)).toBeNull();
    const listed = await env.FILES.list({ prefix: `avatars/${member.id}/` });
    expect(listed.objects).toHaveLength(0);
  });

  it("refuses an upload over 2 MB, by Content-Length and while streaming", async () => {
    const member = await addMember();
    const big = concat(png(10, 10), new Uint8Array(MAX_AVATAR_BYTES));
    const byLength = await upload(member.browser, big, "image/png");
    expect(byLength.status).toBe(413);
    // A chunked body with no Content-Length is counted as it arrives.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(MAX_AVATAR_BYTES / 2));
        controller.close();
      },
    });
    const response = await callWorker(
      new Request(`${ORIGIN}/api/me/avatar`, {
        method: "PUT",
        headers: {
          "cf-connecting-ip": member.browser.ip,
          "x-officebox-request": "1",
          origin: ORIGIN,
          "content-type": "image/png",
          cookie: member.browser.cookieHeader(),
        },
        body: stream,
        // @ts-expect-error -- `duplex` is required for a streamed request body in fetch, not in the Workers types.
        duplex: "half",
      }),
    );
    expect(response.status).toBe(413);
    expect(await avatarKey(member.id)).toBeNull();
  });

  it("needs a session and the CSRF header to upload", async () => {
    const anonymous = new Browser();
    expect((await upload(anonymous, PNG_1X1, "image/png")).status).toBe(401);
    const member = await addMember();
    const res = await callWorker(
      new Request(`${ORIGIN}/api/me/avatar`, {
        method: "PUT",
        headers: { "content-type": "image/png", cookie: member.browser.cookieHeader() },
        body: PNG_1X1,
      }),
    );
    expect(res.status).toBe(403);
  });

  it("a disabled member's avatar stays visible; a deleted member's and unknown ones are 404", async () => {
    const member = await addMember();
    const res = await upload(member.browser, PNG_1X1, "image/png");
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member.id).run();
    expect((await getFile(ws.browser, res.body.avatarUrl!)).status).toBe(200);
    await env.DB.prepare("UPDATE users SET status = 'deleted', email = NULL, email_normalised = NULL WHERE id = ?")
      .bind(member.id)
      .run();
    expect((await getFile(ws.browser, res.body.avatarUrl!)).status).toBe(404);
    expect((await ws.browser.json(`/api/members/${ulid()}/avatar`)).status).toBe(404);
    expect((await ws.browser.json("/api/members/system/avatar")).status).toBe(404);
    expect((await new Browser().json(`/api/members/${member.id}/avatar`)).status).toBe(401);
  });

  it("never serves an object outside the member's own prefix, whatever the stored key says", async () => {
    const victim = await addMember();
    await upload(victim.browser, PNG_1X1, "image/png");
    const victimKey = (await avatarKey(victim.id))!;
    const member = await addMember();
    await env.DB.prepare("UPDATE users SET avatar_key = ? WHERE id = ?").bind(victimKey, member.id).run();
    expect((await ws.browser.json(`/api/members/${member.id}/avatar`)).status).toBe(404);
    // Replacing or removing the member's avatar never deletes an object outside their prefix.
    expect((await upload(member.browser, PNG_1X1, "image/png")).status).toBe(200);
    expect(await env.FILES.head(victimKey)).not.toBeNull();
  });

  it("stores the image with its metadata stripped", async () => {
    const member = await addMember();
    const bytes = jpegWithMetadata("<script>alert(1)</script> GPS 51.5N");
    expect((await upload(member.browser, bytes, "image/jpeg")).status).toBe(200);
    const object = await env.FILES.get((await avatarKey(member.id))!);
    const stored = new Uint8Array(await object!.arrayBuffer());
    expect(stored.length).toBeLessThan(bytes.length);
    expect(contains(stored, "<script>")).toBe(false);
    expect(contains(stored, "GPS")).toBe(false);
  });
});

describe("member directory (Identity §4.10, §9)", () => {
  it("lists active members only, never reserved rows, deleted or disabled people", async () => {
    const disabled = await insertUser("disabled");
    const deleted = await insertUser("deleted");
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: DirectoryPage } = await directory(
        ws.browser,
        cursor ? `?cursor=${encodeURIComponent(cursor)}` : "",
      );
      ids.push(...page.body.members.map((m) => m.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(ids).toContain(ws.ownerId);
    for (const hidden of ["system", "assistant", disabled, deleted]) expect(ids).not.toContain(hidden);
  });

  it("the Deactivated filter lists disabled members only", async () => {
    const disabled = await insertUser("disabled", `Dormant ${ulid()}`);
    const res = await directory(ws.browser, "?filter=deactivated&limit=100");
    expect(res.status).toBe(200);
    expect(res.body.members.map((m) => m.id)).toContain(disabled);
    expect(res.body.members.every((m) => m.deactivated)).toBe(true);
    expect(res.body.members.map((m) => m.id)).not.toContain(ws.ownerId);
    // The card of a disabled member still opens; a deleted one's doesn't.
    expect((await ws.browser.json(`/api/members/${disabled}`)).status).toBe(200);
    expect((await ws.browser.json(`/api/members/${await insertUser("deleted")}`)).status).toBe(404);
    expect((await ws.browser.json("/api/members/system")).status).toBe(404);
  });

  it("searches by name, handle, email, title and team", async () => {
    const tag = ulid().toLowerCase().slice(-8);
    const member = await addMember();
    const handle = `h${tag}`;
    await setProfile(member, {
      displayName: `Quinn N${tag}`,
      handle,
      jobTitle: `Title${tag}`,
      team: `Team${tag}`,
    });
    const email = member.email;
    for (const q of [`n${tag}`, `@${handle}`, email.slice(0, 20), `TITLE${tag}`, `team${tag}`]) {
      const res = await directory(ws.browser, `?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
      expect(
        res.body.members.map((m) => m.id),
        q,
      ).toEqual([member.id]);
    }
    // Region and working hours are shown (Identity §9).
    const res = await directory(ws.browser, `?q=n${tag}`);
    expect(res.body.members[0]).toHaveProperty("workingHours");
    expect(res.body.members[0]).toHaveProperty("region");
    expect(res.body.members[0]).toHaveProperty("timezone");
  });

  it("escapes LIKE wildcards in a search", async () => {
    const res = await directory(ws.browser, `?q=${encodeURIComponent("%")}`);
    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([]);
    expect((await directory(ws.browser, "?q=_")).body.members).toEqual([]);
  });

  it("pages with a cursor, in name order, without repeats", async () => {
    const tag = ulid().toLowerCase().slice(-8);
    const created: Member[] = [];
    for (let i = 0; i < 5; i++) {
      const member = await addMember();
      await setProfile(member, { displayName: `Page${tag} ${String.fromCharCode(69 - i)}`, team: `pg${tag}` });
      created.push(member);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?q=pg${tag}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page: { body: DirectoryPage } = await directory(ws.browser, query);
      seen.push(...page.body.members.map((m) => m.displayName));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(["A", "B", "C", "D", "E"].map((l) => `Page${tag} ${l}`));
  });

  it("refuses a bad query", async () => {
    for (const q of [
      "?cursor=not-a-cursor",
      "?filter=deleted",
      "?limit=0",
      "?limit=101",
      `?q=${"x".repeat(101)}`,
      "?x=1",
    ]) {
      expect((await directory(ws.browser, q)).status, q).toBe(400);
    }
  });

  it("a disabled viewer can't read the directory", async () => {
    const member = await addMember();
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(member.id).run();
    const res = await directory(member.browser);
    expect(res.status).toBe(401);
  });

  it("the owner's profile shows their setup handle", async () => {
    const res = await directory(ws.browser, `?q=${encodeURIComponent(`@${ws.owner.handle}`)}`);
    expect(res.body.members[0]?.handle).toBe(ws.owner.handle);
    // The new account path is unaffected: GET /me carries the avatar URL and time zone.
    const me = await ws.browser.json<{ user: { avatarUrl: string | null; timezone: string } }>("/api/me");
    expect(me.body.user).toMatchObject({ avatarUrl: null, timezone: "UTC" });
  });
});
