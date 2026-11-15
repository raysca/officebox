import { z } from "zod";

/** `GET /health` response body. M0b and M7 add the checks listed in TDD §7.1. */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
