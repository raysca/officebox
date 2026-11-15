import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toastStore } from "../ui/toast-store";
import { ApiRequestError } from "./client";

/** How many times a failed query is retried when the failure is worth retrying. */
export const MAX_QUERY_RETRIES = 2;

/**
 * Whether a failed request is worth retrying: network errors, timeouts and 5xx responses are;
 * 4xx responses (the request itself is wrong, or not allowed), invalid responses and cancellations
 * are not.
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
      return detail.status >= 500;
    case "invalid_response":
    case "aborted":
      return false;
  }
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

function toastMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError(error, query) {
        if (query.meta?.errorToast) toastStore.show(toastMessage(error), "error");
      },
    }),
    mutationCache: new MutationCache({
      onError(error, _variables, _context, mutation) {
        if (mutation.meta?.errorToast !== false) toastStore.show(toastMessage(error), "error");
      },
    }),
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        // Exponential backoff capped at 10 s.
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
        staleTime: 30_000,
      },
      mutations: {
        // A mutation might have reached the server before failing; never repeat it automatically.
        retry: false,
      },
    },
  });
}
