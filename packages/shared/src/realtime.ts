import { z } from "zod";
import { defineMessage, defineMessageSet, type MessageOf } from "./envelope";
import { ulidSchema } from "./ids";

/**
 * Shared realtime contracts (M2a; TDD §2.2, §3.1–3.5; Notifications §5; Platform §12).
 *
 * Every HTTP body and every WebSocket message between the web app and `UserHub` / `WorkspacePresence`
 * is validated with these schemas on both sides (AGENTS §4.1).
 */

/** Kinds of room Durable Object a tab can open a direct socket to (TDD §2.2, Platform §12). */
export const ROOM_KINDS = ["channel", "doc", "board", "project", "huddle", "assistant"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];
export const roomKindSchema = z.enum(ROOM_KINDS);

/** Raw presence states reported by `UserHub` and `WorkspacePresence` (Notifications §5.5). */
export const PRESENCE_STATES = ["online", "idle", "offline"] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];
export const presenceStateSchema = z.enum(PRESENCE_STATES);

/**
 * Derived availability states in precedence order (Notifications §5.6):
 * `away` (time off) > `dnd` (manual) > `focus` (calendar) > `scheduled_dnd` > `online`/`idle`/`offline`.
 */
export const AVAILABILITY_STATES = ["away", "dnd", "focus", "scheduled_dnd", "online", "idle", "offline"] as const;
export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];
export const availabilityStateSchema = z.enum(AVAILABILITY_STATES);

export const AVAILABILITY_SOURCES = ["time_off", "manual_dnd", "focus", "dnd_schedule", "presence"] as const;
export type AvailabilitySource = (typeof AVAILABILITY_SOURCES)[number];
export const availabilitySourceSchema = z.enum(AVAILABILITY_SOURCES);

/** Derived availability returned by `GET /api/members/:id/availability` and broadcast on `status.changed`. */
export const derivedAvailabilitySchema = z.object({
  state: availabilityStateSchema,
  label: z.string(),
  until: z.number().int().nonnegative().nullable(),
  source: availabilitySourceSchema,
});
export type DerivedAvailability = z.infer<typeof derivedAvailabilitySchema>;

/** One user's workspace presence entry (`WorkspacePresence.listOnline` and `hub.welcome`). */
export const presenceEntrySchema = z.object({
  userId: ulidSchema,
  state: z.enum(["online", "idle"]),
  lastSeenAt: z.number().int().nonnegative(),
  statusText: z.string().nullable(),
  availability: derivedAvailabilitySchema.optional(),
});
export type PresenceEntry = z.infer<typeof presenceEntrySchema>;

/** Reasons for closing a user's or session's WebSockets (TDD §3.5). */
export const REVOCATION_REASONS = ["session_revoked", "user_disabled", "access_removed"] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];
export const revocationReasonSchema = z.enum(REVOCATION_REASONS);

/** WebSocket close codes (TDD §3.5, Identity §4.5, Platform §12). */
export const WS_CLOSE_SESSION_REVOKED = 4401;
export const WS_CLOSE_ACCESS_REMOVED = 4403;

/**
 * Target of a short-lived WebSocket upgrade ticket (`POST /api/auth/ws-ticket`, TDD §3.1, §4.2):
 * `"hub"` for the user's `UserHub`, or `"<kind>:<roomId>"` for a room Durable Object.
 */
export const wsTicketTargetSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => {
      if (value === "hub") return true;
      const colon = value.indexOf(":");
      if (colon < 1) return false;
      const kind = value.slice(0, colon);
      const roomId = value.slice(colon + 1);
      return roomKindSchema.safeParse(kind).success && ulidSchema.safeParse(roomId).success;
    },
    { message: "Target must be 'hub' or '<kind>:<ulid>'." },
  );

export const issueWsTicketBodySchema = z.strictObject({
  target: wsTicketTargetSchema,
});
export type IssueWsTicketBody = z.infer<typeof issueWsTicketBodySchema>;

export const wsTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
  target: wsTicketTargetSchema,
});
export type WsTicketResponse = z.infer<typeof wsTicketResponseSchema>;

/** `PUT /api/me/dnd` body: set manual DND until an epoch-ms timestamp, or `null` to clear. */
export const setDndBodySchema = z.strictObject({
  until: z.number().int().positive().nullable(),
});
export type SetDndBody = z.infer<typeof setDndBodySchema>;

/** Recurring daily DND schedule stored as JSON in `user_preferences.dnd_schedule` (Notifications §7). */
const hhmmSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Must be HH:MM (00:00–23:59).");
const dndWindowSchema = z.tuple([hhmmSchema, hhmmSchema]);
export const DND_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DndWeekday = (typeof DND_WEEKDAYS)[number];
export const dndScheduleSchema = z.strictObject({
  mon: z.array(dndWindowSchema).max(6).optional(),
  tue: z.array(dndWindowSchema).max(6).optional(),
  wed: z.array(dndWindowSchema).max(6).optional(),
  thu: z.array(dndWindowSchema).max(6).optional(),
  fri: z.array(dndWindowSchema).max(6).optional(),
  sat: z.array(dndWindowSchema).max(6).optional(),
  sun: z.array(dndWindowSchema).max(6).optional(),
});
export type DndSchedule = z.infer<typeof dndScheduleSchema>;

/** `PATCH /api/me/preferences` body for timezone and scheduled DND (Notifications §7). */
export const updateRealtimePreferencesBodySchema = z.strictObject({
  timezone: z.string().min(1).max(64).optional(),
  dndSchedule: dndScheduleSchema.nullable().optional(),
});
export type UpdateRealtimePreferencesBody = z.infer<typeof updateRealtimePreferencesBodySchema>;

/**
 * Client → `UserHub` WebSocket messages (Notifications §5.5, Platform §12).
 *
 * Each browser tab reports whether it is visible (`document.visibilityState === "visible"`) and the
 * timestamp of its most recent user input (`keydown`, `pointerdown`, `scroll`, `focus`). A user is
 * `online` when at least one tab is visible and had input within the last 2 minutes (`ACTIVE_WINDOW_MS`).
 */
export const tabStateMessageSchema = defineMessage("tab.state", {
  visible: z.boolean(),
  lastInputAt: z.number().int().nonnegative(),
});
export type TabStateMessage = z.infer<typeof tabStateMessageSchema>;

export const hubClientMessages = defineMessageSet([tabStateMessageSchema]);
export type HubClientMessage = MessageOf<typeof hubClientMessages>;

/**
 * `UserHub` → Client WebSocket messages (TDD §2.2, §3.4, §3.5; Notifications §5.5–5.7).
 */
export const hubWelcomeMessageSchema = defineMessage("hub.welcome", {
  userId: ulidSchema,
  sessionId: z.string().min(1),
  connectionId: ulidSchema,
  presence: presenceStateSchema,
  availability: derivedAvailabilitySchema,
  online: z.array(presenceEntrySchema),
});
export type HubWelcomeMessage = z.infer<typeof hubWelcomeMessageSchema>;

export const presenceChangedMessageSchema = defineMessage("presence.changed", {
  userId: ulidSchema,
  state: presenceStateSchema,
  lastSeenAt: z.number().int().nonnegative(),
  statusText: z.string().nullable(),
});
export type PresenceChangedMessage = z.infer<typeof presenceChangedMessageSchema>;

export const statusChangedMessageSchema = defineMessage("status.changed", {
  userId: ulidSchema,
  availability: derivedAvailabilitySchema,
});
export type StatusChangedMessage = z.infer<typeof statusChangedMessageSchema>;

export const accessChangedMessageSchema = defineMessage("access.changed", {
  roomKind: roomKindSchema,
  roomId: ulidSchema,
  role: z.string().min(1).nullable(),
});
export type AccessChangedMessage = z.infer<typeof accessChangedMessageSchema>;

export const hubActivityPayloadValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type HubActivityPayloadValue = z.infer<typeof hubActivityPayloadValueSchema>;

export const hubActivityEventSchema = z.strictObject({
  id: ulidSchema,
  kind: z.string().min(1),
  roomKind: roomKindSchema.optional(),
  roomId: ulidSchema.optional(),
  actorId: ulidSchema.nullable().optional(),
  createdAt: z.number().int().nonnegative(),
  payload: z.record(z.string(), hubActivityPayloadValueSchema).default({}),
});
export type HubActivityEvent = z.infer<typeof hubActivityEventSchema>;

export const hubActivityMessageSchema = defineMessage("hub.activity", {
  events: z.array(hubActivityEventSchema).min(1),
});
export type HubActivityMessage = z.infer<typeof hubActivityMessageSchema>;

export const hubServerMessages = defineMessageSet([
  hubWelcomeMessageSchema,
  presenceChangedMessageSchema,
  statusChangedMessageSchema,
  accessChangedMessageSchema,
  hubActivityMessageSchema,
]);
export type HubServerMessage = MessageOf<typeof hubServerMessages>;

/** Timing constants shared between client and server (Notifications §5.5, Platform §11–12). */
export const ACTIVE_WINDOW_MS = 2 * 60_000;
export const HUB_HEARTBEAT_MS = 5 * 60_000;
export const PRESENCE_EXPIRY_MS = 12 * 60_000;
export const WS_TICKET_TTL_MS = 30_000;
export const MAX_SOCKETS_PER_TAB = 6;
