import { healthResponseSchema } from "@officebox/shared";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, unwrap } from "./client";

export const healthQueryKey = ["health"] as const;

/** `GET /health`: whether the Worker is up, and the deployed version. Refreshes every minute. */
export function useHealth() {
  return useQuery({
    queryKey: healthQueryKey,
    queryFn: async ({ signal }) => unwrap(await apiRequest("/health", { schema: healthResponseSchema, signal })),
    refetchInterval: 60_000,
  });
}
