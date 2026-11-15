import type { Feature } from "../core/app";

/**
 * Feature route modules, mounted under `/api/<name>`. Each feature lives in `src/features/<feature>/`
 * with its routes, Durable Objects, services and jobs, and exports a `defineFeature(...)` value that is
 * listed here. M1 adds `auth` and `members`.
 */
export const features: readonly Feature[] = [];
