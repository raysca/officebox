// Q2: @simplewebauthn/server loads and runs in workerd. The browser round trip (virtual authenticator,
// registration + authentication + sign_count) is in scripts/webauthn-e2e.mjs against wrangler dev.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isCounterRegression } from "../src/webauthn";

const post = (path: string, body: unknown) =>
  exports.default.fetch(`http://localhost:8787${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("@simplewebauthn/server in workerd", () => {
  it("generates registration options for a discoverable credential", async () => {
    const res = await post("/webauthn/register/options", { username: `u-${crypto.randomUUID()}@example.com` });
    expect(res.status).toBe(200);
    // any: loose JSON shape, only used for assertions.
    const { flowId, options } = await res.json<{ flowId: string; options: Record<string, any> }>();
    expect(flowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(options.rp).toEqual({ name: "Officebox spike", id: "localhost" });
    expect(options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "preferred" });
    expect(options.pubKeyCredParams.map((p: { alg: number }) => p.alg)).toEqual([-7, -257]);
  });

  it("generates authentication options without allowCredentials (passkey sign-in)", async () => {
    // any: loose JSON shape, only used for assertions.
    const { options } = await (await post("/webauthn/login/options", {})).json<{ options: Record<string, any> }>();
    expect(options.rpId).toBe("localhost");
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.userVerification).toBe("preferred");
  });

  it("refuses a garbage registration response with a typed error, not a thrown exception", async () => {
    const { flowId } = await (await post("/webauthn/register/options", { username: "x@example.com" })).json<{ flowId: string }>();
    const res = await post("/webauthn/register/verify", {
      flowId,
      response: { id: "AAAA", rawId: "AAAA", type: "public-key", response: { clientDataJSON: "e30", attestationObject: "oA" }, clientExtensionResults: {} },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_response" });
  });

  it("challenges are single-use: a second verify with the same flow is refused", async () => {
    const { flowId } = await (await post("/webauthn/register/options", { username: "y@example.com" })).json<{ flowId: string }>();
    const bogus = { id: "AAAA", rawId: "AAAA", type: "public-key", response: { clientDataJSON: "e30", attestationObject: "oA" }, clientExtensionResults: {} };
    await post("/webauthn/register/verify", { flowId, response: bogus });
    const again = await post("/webauthn/register/verify", { flowId, response: bogus });
    expect(await again.json()).toMatchObject({ ok: false, error: "unknown_flow" });
  });

  it("refuses sign-in with an unknown credential", async () => {
    const { flowId } = await (await post("/webauthn/login/options", {})).json<{ flowId: string }>();
    const res = await post("/webauthn/login/verify", {
      flowId,
      response: { id: "bm9wZQ", rawId: "bm9wZQ", type: "public-key", response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" }, clientExtensionResults: {} },
    });
    expect(await res.json()).toMatchObject({ ok: false, error: "unknown_credential" });
  });
});

describe("sign_count rule (isCounterRegression)", () => {
  it("rejects a counter that goes backwards, repeats a non-zero value or resets to zero", () => {
    expect(isCounterRegression(1, 3)).toBe(true);
    expect(isCounterRegression(3, 3)).toBe(true);
    expect(isCounterRegression(0, 3)).toBe(true);
  });
  it("accepts an increasing counter and authenticators that always report 0", () => {
    expect(isCounterRegression(4, 3)).toBe(false);
    expect(isCounterRegression(1, 0)).toBe(false);
    expect(isCounterRegression(0, 0)).toBe(false);
  });
});
