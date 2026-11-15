import { healthResponseSchema } from "@officebox/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { jsonResponse } from "../../test/render-app";
import { toastStore } from "../ui/toast-store";
import { ApiRequestError, apiRequest, CSRF_HEADER, describeApiError, unwrap, type ApiClientError } from "./client";
import { createQueryClient, shouldRetry } from "./query-client";

function fetchReturning(response: Response | (() => Promise<Response>)) {
  return vi.fn<typeof fetch>(() => (typeof response === "function" ? response() : Promise.resolve(response)));
}

function headersOf(mock: ReturnType<typeof fetchReturning>): Record<string, string> {
  const init = mock.mock.calls[0]?.[1];
  return (init?.headers ?? {}) as Record<string, string>;
}

/** A fetch that never answers until its signal aborts, like a hung connection. */
function hangingFetch() {
  return vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
  );
}

describe("apiRequest", () => {
  it("returns the parsed body on success, with same-origin credentials", async () => {
    const fetch = fetchReturning(jsonResponse({ status: "ok", version: "1.2.3" }));
    const result = await apiRequest("/health", { schema: healthResponseSchema, fetch });
    expect(result).toEqual({ ok: true, value: { status: "ok", version: "1.2.3" } });
    expect(fetch.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
  });

  it("doesn't send the CSRF header on safe methods", async () => {
    const fetch = fetchReturning(jsonResponse({}));
    await apiRequest("/api/x", { fetch });
    expect(headersOf(fetch)[CSRF_HEADER]).toBeUndefined();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "post"])("sends X-Officebox-Request: 1 on %s", async (method) => {
    const fetch = fetchReturning(new Response(null, { status: 204 }));
    const result = await apiRequest("/api/x", { method, body: { a: 1 }, fetch });
    expect(result.ok).toBe(true);
    const headers = headersOf(fetch);
    expect(headers[CSRF_HEADER]).toBe("1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(fetch.mock.calls[0]?.[1]?.body).toBe('{"a":1}');
    expect(fetch.mock.calls[0]?.[1]?.method).toBe(method.toUpperCase());
  });

  it("maps the shared error body to a typed api error", async () => {
    const body = { error: { code: "forbidden", message: "You can't do that." } };
    const result = await apiRequest("/api/x", { fetch: fetchReturning(jsonResponse(body, 403)) });
    expect(result).toEqual({
      ok: false,
      error: { kind: "api", status: 403, error: { code: "forbidden", message: "You can't do that." } },
    });
  });

  it("keeps rate-limit and field details", async () => {
    const body = {
      error: { code: "rate_limited", message: "Slow down.", retryAfterSeconds: 30, fields: { name: ["Too long"] } },
    };
    const result = await apiRequest("/api/x", { fetch: fetchReturning(jsonResponse(body, 429)) });
    expect(!result.ok && result.error.kind === "api" && result.error.error.retryAfterSeconds).toBe(30);
    expect(!result.ok && result.error.kind === "api" && result.error.error.fields).toEqual({ name: ["Too long"] });
  });

  it("maps a non-2xx response without a valid error body to an http error", async () => {
    const html = new Response("<h1>Bad gateway</h1>", { status: 502 });
    expect(await apiRequest("/api/x", { fetch: fetchReturning(html) })).toEqual({
      ok: false,
      error: { kind: "http", status: 502 },
    });
    // An unknown error code doesn't pass the shared schema either.
    const unknownCode = jsonResponse({ error: { code: "teapot", message: "?" } }, 418);
    expect(await apiRequest("/api/x", { fetch: fetchReturning(unknownCode) })).toEqual({
      ok: false,
      error: { kind: "http", status: 418 },
    });
  });

  it("maps a 2xx body that fails the schema to invalid_response", async () => {
    const fetch = fetchReturning(jsonResponse({ status: "maybe" }));
    expect(await apiRequest("/health", { schema: healthResponseSchema, fetch })).toEqual({
      ok: false,
      error: { kind: "invalid_response", status: 200 },
    });
    const notJson = fetchReturning(new Response("not json", { status: 200 }));
    expect(await apiRequest("/x", { schema: z.object({}), fetch: notJson })).toEqual({
      ok: false,
      error: { kind: "invalid_response", status: 200 },
    });
  });

  it("maps a fetch rejection to a network error", async () => {
    const fetch = fetchReturning(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await apiRequest("/api/x", { fetch })).toEqual({ ok: false, error: { kind: "network" } });
  });

  it("maps a hung request to a timeout", async () => {
    vi.useFakeTimers();
    const pending = apiRequest("/api/x", { fetch: hangingFetch(), timeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({ ok: false, error: { kind: "timeout", timeoutMs: 5_000 } });
  });

  it("maps a caller abort to aborted, not a timeout", async () => {
    const controller = new AbortController();
    const pending = apiRequest("/api/x", { fetch: hangingFetch(), signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { kind: "aborted" } });

    // Already aborted before the call.
    expect(await apiRequest("/api/x", { fetch: hangingFetch(), signal: controller.signal })).toEqual({
      ok: false,
      error: { kind: "aborted" },
    });
  });
});

describe("unwrap and describeApiError", () => {
  it("returns the value or throws an ApiRequestError carrying the typed error", () => {
    expect(unwrap({ ok: true, value: 1 })).toBe(1);
    const detail: ApiClientError = { kind: "api", status: 404, error: { code: "not_found", message: "Gone fishing." } };
    try {
      unwrap({ ok: false, error: detail });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError);
      expect((error as ApiRequestError).detail).toEqual(detail);
      expect((error as ApiRequestError).status).toBe(404);
      expect((error as ApiRequestError).message).toBe("Gone fishing.");
    }
  });

  it("gives a safe message for every kind", () => {
    expect(describeApiError({ kind: "network" })).toMatch(/Can't reach the server/);
    expect(describeApiError({ kind: "timeout", timeoutMs: 1 })).toMatch(/too long/);
    expect(describeApiError({ kind: "http", status: 503 })).toMatch(/server had a problem/);
    expect(describeApiError({ kind: "http", status: 400 })).toBe("The request failed (HTTP 400).");
    expect(describeApiError({ kind: "invalid_response", status: 200 })).toMatch(/unexpected response/);
    expect(describeApiError({ kind: "aborted" })).toMatch(/cancelled/);
  });
});

describe("query retries", () => {
  const e = (detail: ApiClientError) => new ApiRequestError(detail);
  const api = (status: number) =>
    e({ kind: "api", status, error: { code: status >= 500 ? "internal" : "forbidden", message: "x" } });

  it("retries network errors, timeouts and 5xx responses", () => {
    expect(shouldRetry(0, e({ kind: "network" }))).toBe(true);
    expect(shouldRetry(0, e({ kind: "timeout", timeoutMs: 1 }))).toBe(true);
    expect(shouldRetry(0, api(500))).toBe(true);
    expect(shouldRetry(0, e({ kind: "http", status: 503 }))).toBe(true);
  });

  it("never retries 4xx responses, invalid responses, cancellations or unknown errors", () => {
    for (const status of [400, 401, 403, 404, 409, 429]) {
      expect(shouldRetry(0, api(status))).toBe(false);
      expect(shouldRetry(0, e({ kind: "http", status }))).toBe(false);
    }
    expect(shouldRetry(0, e({ kind: "invalid_response", status: 200 }))).toBe(false);
    expect(shouldRetry(0, e({ kind: "aborted" }))).toBe(false);
    expect(shouldRetry(0, new Error("bug"))).toBe(false);
  });

  it("stops after two retries", () => {
    expect(shouldRetry(1, e({ kind: "network" }))).toBe(true);
    expect(shouldRetry(2, e({ kind: "network" }))).toBe(false);
  });
});

describe("error toasts", () => {
  const failure = () =>
    Promise.reject(new ApiRequestError({ kind: "api", status: 409, error: { code: "conflict", message: "Taken." } }));

  it("shows a toast when a mutation fails, unless it opts out", async () => {
    const client = createQueryClient();
    await client
      .getMutationCache()
      .build(client, { mutationFn: failure })
      .execute(undefined)
      .catch(() => undefined);
    expect(toastStore.getSnapshot().map((t) => [t.tone, t.message])).toEqual([["error", "Taken."]]);

    toastStore.clear();
    await client
      .getMutationCache()
      .build(client, { mutationFn: failure, meta: { errorToast: false } })
      .execute(undefined)
      .catch(() => undefined);
    expect(toastStore.getSnapshot()).toEqual([]);
  });

  it("shows query errors inline by default, and as a toast only when asked", async () => {
    const client = createQueryClient();
    await client.fetchQuery({ queryKey: ["a"], queryFn: failure, retry: false }).catch(() => undefined);
    expect(toastStore.getSnapshot()).toEqual([]);

    await client
      .fetchQuery({ queryKey: ["b"], queryFn: failure, retry: false, meta: { errorToast: true } })
      .catch(() => undefined);
    expect(toastStore.getSnapshot().map((t) => t.message)).toEqual(["Taken."]);
  });
});
