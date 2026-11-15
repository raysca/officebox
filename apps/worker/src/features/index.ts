import type { Feature } from "../core/app";
import { adminFeature } from "./admin/routes";
import {
  authFeature,
  invitationsFeature,
  meFeature,
  setupFeature,
  signInFeature,
  statusFeature,
} from "./identity/routes";

/**
 * Feature route modules, mounted under `/api/<name>`. Each feature lives in `src/features/<feature>/`
 * with its routes, Durable Objects, services and jobs, and exports `defineFeature(...)` values that
 * are listed here. Identity (M1) serves `/api/setup`, `/api/auth` (better-auth behind its allowlist),
 * `/api/me`, `/api/invitations`, `/api/sign-in` and `/api/status`; the admin area serves `/api/admin`.
 */
export const features: readonly Feature[] = [
  setupFeature,
  authFeature,
  meFeature,
  invitationsFeature,
  signInFeature,
  statusFeature,
  adminFeature,
];
