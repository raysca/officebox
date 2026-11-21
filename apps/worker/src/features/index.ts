import type { Feature } from "../core/app";
import { adminFeature } from "./admin/routes";
import {
  authFeature,
  invitationsFeature,
  meFeature,
  recoverFeature,
  setupFeature,
  signInFeature,
  statusFeature,
} from "./identity/routes";
import { handlesFeature } from "./identity/profile-routes";
import { membersFeature, realtimeFeature, wsFeature } from "./realtime/routes";

/**
 * Feature route modules, mounted under `/api/<name>`. Each feature lives in `src/features/<feature>/`
 * with its routes, Durable Objects, services and jobs, and exports `defineFeature(...)` values that
 * are listed here. Identity (M1) serves `/api/setup`, `/api/auth` (better-auth behind its allowlist),
 * `/api/me`, `/api/invitations`, `/api/sign-in`, `/api/status` and `/api/recover` (M1c); the admin area serves `/api/admin`;
 * realtime (M2a) serves `/api/ws`, `/api/members` (with identity's directory, M1d) and `/api/realtime`;
 * `/api/handles` is identity's handle check (M1d).
 */
export const features: readonly Feature[] = [
  setupFeature,
  authFeature,
  meFeature,
  invitationsFeature,
  signInFeature,
  statusFeature,
  recoverFeature,
  handlesFeature,
  adminFeature,
  wsFeature,
  membersFeature,
  realtimeFeature,
];
