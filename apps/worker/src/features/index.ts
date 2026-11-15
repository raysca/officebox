import type { Feature } from "../core/app";
import { authFeature, meFeature, setupFeature } from "./identity/routes";

/**
 * Feature route modules, mounted under `/api/<name>`. Each feature lives in `src/features/<feature>/`
 * with its routes, Durable Objects, services and jobs, and exports `defineFeature(...)` values that
 * are listed here. Identity (M1) serves `/api/setup`, `/api/auth` (better-auth behind its allowlist)
 * and `/api/me`.
 */
export const features: readonly Feature[] = [setupFeature, authFeature, meFeature];
