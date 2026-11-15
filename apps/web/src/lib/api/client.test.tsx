import { ERROR_CODES, healthResponseSchema } from "@officebox/shared";
import type { QueryClient } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { jsonResponse } from "../../test/render-app";
import { messages } from "../../app/messages";
import { Toaster } from "../ui/Toaster";
import { toastStore } from "../ui/toast-store";
import {
  ApiRequestError,
  apiRequest,
  CSRF_HEADER,
  describeApiError,
  parseRetryAfter,
  unwrap,
  type ApiClientError,
} from "./client";
import { createQueryClient, MAX_RETRY_DELAY_MS, retryDelay, shouldRetry } from "./query-client";

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

describe("Retry-After", () => {
  it("is read from the header, as seconds or an HTTP date", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("120")).toBe(120);
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-11-15T10:00:00Z");
    expect(parseRetryAfter("Sun, 15 Nov 2026 10:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Sun, 15 Nov 2026 09:00:00 GMT", now)).toBe(0);
  });

  it("is carried on http and api errors, the body's value winning", async () => {
    const headers = { "Retry-After": "7", "Content-Type": "application/json" };
    const plain = new Response("", { status: 429, headers });
    expect(await apiRequest("/api/x", { fetch: fetchReturning(plain) })).toEqual({
      ok: false,
      error: { kind: "http", status: 429, retryAfterSeconds: 7 },
    });
    const body = JSON.stringify({ error: { code: "rate_limited", message: "x", retryAfterSeconds: 3 } });
    const withBody = new Response(body, { status: 429, headers });
    const result = await apiRequest("/api/x", { fetch: fetchReturning(withBody) });
    expect(!result.ok && result.error.kind === "api" && result.error.retryAfterSeconds).toBe(3);
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
      // The Error message is a developer summary for logs.
      expect((error as ApiRequestError).message).toBe("API error 404 not_found: Gone fishing.");
    }
  });

  it("describes server errors by code, never with the server's message", () => {
    for (const code of ERROR_CODES) {
      const text = describeApiError({ kind: "api", status: 400, error: { code, message: "internal detail" } });
      expect(text).toBe(messages.errors.byCode[code]);
      expect(text).not.toContain("internal detail");
    }
  });

  it("gives a safe message for every kind", () => {
    expect(describeApiError({ kind: "network" })).toBe(messages.errors.network);
    expect(describeApiError({ kind: "timeout", timeoutMs: 1 })).toBe(messages.errors.timeout);
    expect(describeApiError({ kind: "http", status: 503 })).toBe(messages.errors.server);
    expect(describeApiError({ kind: "http", status: 400 })).toBe(messages.errors.generic);
    expect(describeApiError({ kind: "http", status: 401 })).toBe(messages.errors.byCode.unauthenticated);
    expect(describeApiError({ kind: "http", status: 403 })).toBe(messages.errors.byCode.forbidden);
    expect(describeApiError({ kind: "http", status: 404 })).toBe(messages.errors.byCode.not_found);
    expect(describeApiError({ kind: "http", status: 429 })).toBe(messages.errors.byCode.rate_limited);
    expect(describeApiError({ kind: "invalid_response", status: 200 })).toBe(messages.errors.invalidResponse);
    expect(describeApiError({ kind: "aborted" })).toBe(messages.errors.aborted);
  });

  it("says a mutation's outcome is unknown after a timeout or a lost connection", () => {
    expect(describeApiError({ kind: "network" }, "mutation")).toBe(messages.errors.outcomeUnknown);
    expect(describeApiError({ kind: "timeout", timeoutMs: 1 }, "mutation")).toBe(messages.errors.outcomeUnknown);
    expect(messages.errors.outcomeUnknown).toMatch(/couldn't confirm/);
  });
});

describe("query retries", () => {
  const e = (detail: ApiClientError) => new ApiRequestError(detail);
  const api = (status: number) =>
    e({ kind: "api", status, error: { code: status >= 500 ? "internal" : "forbidden", message: "x" } });

  it("retries network errors, timeouts, 5xx, 408 and 429", () => {
    expect(shouldRetry(0, e({ kind: "network" }))).toBe(true);
    expect(shouldRetry(0, e({ kind: "timeout", timeoutMs: 1 }))).toBe(true);
    expect(shouldRetry(0, api(500))).toBe(true);
    expect(shouldRetry(0, e({ kind: "http", status: 503 }))).toBe(true);
    for (const status of [408, 429]) {
      expect(shouldRetry(0, api(status))).toBe(true);
      expect(shouldRetry(0, e({ kind: "http", status }))).toBe(true);
    }
  });

  it("never retries other 4xx responses, invalid responses, cancellations or unknown errors", () => {
    for (const status of [400, 401, 403, 404, 409, 413]) {
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

  it("waits for Retry-After, capped, and otherwise backs off exponentially", () => {
    expect(retryDelay(0, e({ kind: "http", status: 429, retryAfterSeconds: 5 }))).toBe(5_000);
    expect(retryDelay(0, e({ kind: "http", status: 429, retryAfterSeconds: 3600 }))).toBe(MAX_RETRY_DELAY_MS);
    expect(retryDelay(0, e({ kind: "network" }))).toBe(1_000);
    expect(retryDelay(2, e({ kind: "network" }))).toBe(4_000);
    expect(retryDelay(10, new Error("x"))).toBe(10_000);
  });

  it("never retries mutations, even on 429", async () => {
    const client = createQueryClient();
    const mutationFn = vi.fn(() => Promise.reject(e({ kind: "http", status: 429, retryAfterSeconds: 0 })));
    await client
      .getMutationCache()
      .build(client, { mutationFn })
      .execute(undefined)
      .catch(() => undefined);
    expect(mutationFn).toHaveBeenCalledTimes(1);
  });
});

describe("error toasts", () => {
  const failure = () =>
    Promise.reject(new ApiRequestError({ kind: "api", status: 409, error: { code: "conflict", message: "Taken." } }));

  async function runMutation(client: QueryClient, mutationFn: () => Promise<unknown>, meta?: { errorToast?: boolean }) {
    await client
      .getMutationCache()
      .build(client, { mutationFn, meta })
      .execute(undefined)
      .catch(() => undefined);
  }

  it("shows a toast when a mutation fails, unless it opts out", async () => {
    const client = createQueryClient();
    await runMutation(client, failure);
    expect(toastStore.getSnapshot().map((t) => [t.tone, t.message])).toEqual([
      ["error", messages.errors.byCode.conflict],
    ]);

    toastStore.clear();
    await runMutation(client, failure, { errorToast: false });
    expect(toastStore.getSnapshot()).toEqual([]);
  });

  it("says a timed-out mutation may have gone through", async () => {
    const client = createQueryClient();
    await runMutation(client, () => Promise.reject(new ApiRequestError({ kind: "timeout", timeoutMs: 1 })));
    expect(toastStore.getSnapshot().map((t) => t.message)).toEqual([messages.errors.outcomeUnknown]);
  });

  it("shows query errors inline by default, and as a toast only when asked", async () => {
    const client = createQueryClient();
    await client.fetchQuery({ queryKey: ["a"], queryFn: failure, retry: false }).catch(() => undefined);
    expect(toastStore.getSnapshot()).toEqual([]);

    await client
      .fetchQuery({ queryKey: ["b"], queryFn: failure, retry: false, meta: { errorToast: true } })
      .catch(() => undefined);
    expect(toastStore.getSnapshot().map((t) => t.message)).toEqual([messages.errors.byCode.conflict]);
  });

  it("never puts raw error text on the screen", async () => {
    render(<Toaster />);
    const client = createQueryClient();
    const leak = () => Promise.reject(new Error("secret stack detail"));
    const serverLeak = () =>
      Promise.reject(new ApiRequestError({ kind: "api", status: 500, error: { code: "internal", message: "secret" } }));

    await act(async () => {
      await runMutation(client, leak);
      await client
        .fetchQuery({ queryKey: ["leak"], queryFn: leak, retry: false, meta: { errorToast: true } })
        .catch(() => undefined);
      await runMutation(client, serverLeak);
    });

    expect(screen.getAllByText(messages.errors.generic)).toHaveLength(1);
    expect(screen.getByText(messages.errors.byCode.internal)).toBeDefined();
    expect(document.body.textContent).not.toContain("secret");
  });
});

describe("unauthorized hook", () => {
  it("is called for 401 and unauthenticated failures from queries and mutations, and nothing else", async () => {
    const onUnauthorized = vi.fn();
    const client = createQueryClient({ onUnauthorized });
    const reject = (detail: ApiClientError) => () => Promise.reject(new ApiRequestError(detail));

    await client
      .fetchQuery({ queryKey: ["u1"], queryFn: reject({ kind: "http", status: 401 }), retry: false })
      .catch(() => undefined);
    await client
      .getMutationCache()
      .build(client, {
        mutationFn: reject({ kind: "api", status: 401, error: { code: "unauthenticated", message: "x" } }),
        meta: { errorToast: false },
      })
      .execute(undefined)
      .catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);

    await client
      .fetchQuery({ queryKey: ["u2"], queryFn: reject({ kind: "http", status: 403 }), retry: false })
      .catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });
});
