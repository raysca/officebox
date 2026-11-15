import { z } from "zod";

/** One dependency checked by `GET /health`. `detail` is a short, fixed phrase; never an error message. */
export const healthCheckSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative().optional(),
  detail: z.string().optional(),
});

export type HealthCheck = z.infer<typeof healthCheckSchema>;

/**
 * `GET /health` response body: 200 with `status: "ok"`, or 503 with `status: "error"` and the failing
 * checks. M0 checks D1, the system Durable Object and the queue binding; M7 adds the rest of TDD §7.1.
 */
export const healthResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
  version: z.string(),
  checks: z.record(z.string(), healthCheckSchema),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
