import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { messages } from "../../app/messages";
import { toastStore } from "../ui/toast-store";
import { ApiRequestError, describeApiError, isUnauthorized, type RequestOperation } from "./client";

/** How many times a failed query is retried when the failure is worth retrying. */
export const MAX_QUERY_RETRIES = 2;
/** The longest a query waits before a retry, even if the server's Retry-After asks for longer. */
export const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Whether a failed query is worth retrying: network errors, timeouts, 5xx, 408 (request timeout) and
 * 429 (rate limited, after its Retry-After) are; other 4xx responses (the request itself is wrong,
 * or not allowed), invalid responses and cancellations are not. Mutations never retry.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  if (!(error instanceof ApiRequestError)) return false;
  const { detail } = error;
  switch (detail.kind) {
    case "network":
    case "timeout":
      return true;
    case "api":
    case "http":
      return detail.status >= 500 || detail.status === 408 || detail.status === 429;
    case "invalid_response":
    case "aborted":
      return false;
  }
}

/** Waits for the server's Retry-After when it gave one, else backs off exponentially; capped. */
export function retryDelay(attempt: number, error: unknown): number {
  if (error instanceof ApiRequestError && "retryAfterSeconds" in error.detail) {
    const seconds = error.detail.retryAfterSeconds;
    if (seconds !== undefined) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  }
  return Math.min(1000 * 2 ** attempt, 10_000);
}

/**
 * Per-query and per-mutation options for error display.
 *
 * - Queries show errors inline where their data would be (the default). Set `meta.errorToast: true`
 *   for background queries with nowhere to show one.
 * - Mutations are actions the person took, so a failure shows a toast unless the form handles it
 *   inline and sets `meta.errorToast: false`.
 */
declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: { errorToast?: boolean };
    mutationMeta: { errorToast?: boolean };
  }
}

/**
 * The text of an error toast. Only typed API errors are described; anything else (a bug, a thrown
 * Error with internal detail) gets generic copy, so raw error text never reaches the screen.
 */
export function toastMessage(error: unknown, operation: RequestOperation): string {
  return error instanceof ApiRequestError ? describeApiError(error.detail, operation) : messages.errors.generic;
}

export interface CreateQueryClientOptions {
  /**
   * Called when any query or mutation fails because the session is missing or expired.
   * TODO(M1): sign the person out and send them to sign-in, keeping where they were.
   */
  onUnauthorized?: () => void;
}

export function createQueryClient({ onUnauthorized = () => {} }: CreateQueryClientOptions = {}): QueryClient {
  function handleUnauthorized(error: unknown) {
    if (error instanceof ApiRequestError && isUnauthorized(error.detail)) onUnauthorized();
  }

  return new QueryClient({
    queryCache: new QueryCache({
      onError(error, query) {
        handleUnauthorized(error);
        if (query.meta?.errorToast) toastStore.show(toastMessage(error, "query"), "error");
      },
    }),
    mutationCache: new MutationCache({
      onError(error, _variables, _context, mutation) {
        handleUnauthorized(error);
        if (mutation.meta?.errorToast !== false) toastStore.show(toastMessage(error, "mutation"), "error");
      },
    }),
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        retryDelay,
        staleTime: 30_000,
      },
      mutations: {
        // A mutation might have reached the server before failing; never repeat it automatically.
        retry: false,
      },
    },
  });
}
