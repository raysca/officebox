import { z } from "zod";
import { defineMessage } from "./envelope";

/**
 * Email delivery schemas (TDD §7.6; Platform §7 `email_provider`, §16).
 *
 * The admin picks a **driver** and enters the **sender address** in settings. Nothing defaults to a
 * particular domain (AGENTS §4.1): until an owner configures it, email is off and invitations are
 * copy-link only. Provider keys and SMTP passwords are **Worker secrets**, never settings, so nothing
 * here is secret.
 */

export const EMAIL_DRIVERS = ["none", "cloudflare", "resend", "postmark", "ses", "smtp"] as const;
export const emailDriverSchema = z.enum(EMAIL_DRIVERS);
export type EmailDriverKind = z.infer<typeof emailDriverSchema>;

/** A sender address: an ordinary email address, never a default domain. */
export const senderAddressSchema = z.string().trim().max(254).pipe(z.email());

/** A display name for the From header: no line breaks or angle brackets (header injection). */
export const senderNameSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^[^\r\n<>"]*$/, { message: "No line breaks, quotes or angle brackets." });

/** A hostname for SMTP: letters, digits, dots and dashes only (no scheme, path or port). */
const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/, {
    message: "A hostname such as smtp.example.com.",
  })
  // A name, never an IP literal (Platform §9 outbound rules): the last label must not be a number
  // (decimal, or 0x hex), so dotted IPv4 forms are refused; IPv6 literals never match the pattern above.
  .refine((host) => !/^(\d+|0x[0-9a-f]*)$/.test(host.slice(host.lastIndexOf(".") + 1)), {
    message: "A hostname such as smtp.example.com, not an IP address.",
  })
  // Names reserved for loopback and private networks. Wildcard DNS (nip.io and the like) can't be ruled
  // out by name; Workers' connect() can't reach private address ranges anyway (Platform §9).
  .refine((host) => !/(^|\.)(localhost|local|internal)$/.test(host), {
    message: "A public hostname: not localhost, .local or .internal.",
  });

/** An AWS region name such as `eu-west-1`. */
const awsRegionSchema = z
  .string()
  .trim()
  .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/, { message: "A region such as eu-west-1." });

const sender = { from: senderAddressSchema, fromName: senderNameSchema.optional() };

/**
 * The `email_provider` setting (Platform §7, owner-only). `none` until configured. The secrets each
 * driver reads are listed in {@link EMAIL_DRIVER_SECRETS}.
 */
export const emailProviderSchema = z.discriminatedUnion("driver", [
  z.strictObject({ driver: z.literal("none") }),
  z.strictObject({ driver: z.literal("cloudflare"), ...sender }),
  z.strictObject({ driver: z.literal("resend"), ...sender }),
  z.strictObject({ driver: z.literal("postmark"), ...sender }),
  z.strictObject({ driver: z.literal("ses"), ...sender, region: awsRegionSchema }),
  z.strictObject({
    driver: z.literal("smtp"),
    ...sender,
    host: hostnameSchema,
    /** 587 with STARTTLS, or 465 with implicit TLS (Cloudflare blocks port 25). */
    port: z.union([z.literal(587), z.literal(465), z.literal(2525)]),
    security: z.enum(["starttls", "tls"]),
    username: z.string().trim().min(1).max(254),
  }),
]);
export type EmailProvider = z.infer<typeof emailProviderSchema>;

/** Worker secrets each driver needs (Platform §16). The Cloudflare driver uses the `EMAIL` binding. */
export const EMAIL_DRIVER_SECRETS: Readonly<Record<EmailDriverKind, readonly string[]>> = {
  none: [],
  cloudflare: [],
  resend: ["RESEND_API_KEY"],
  postmark: ["POSTMARK_SERVER_TOKEN"],
  ses: ["SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY"],
  smtp: ["SMTP_PASSWORD"],
};

/** Whether email works right now, for the admin settings page and the sign-in page. */
export const emailStatusSchema = z.object({
  driver: emailDriverSchema,
  configured: z.boolean(),
  /** Secret names (never values) or the binding the chosen driver still needs. */
  missing: z.array(z.string()),
});
export type EmailStatus = z.infer<typeof emailStatusSchema>;

/** `POST /api/admin/email/test`: a test email to the signed-in owner or admin's own address. */
export const sendTestEmailBodySchema = z.strictObject({});
export type SendTestEmailBody = z.infer<typeof sendTestEmailBodySchema>;

export const sendTestEmailResultSchema = z.object({
  /** Where it went: always the actor's own address. */
  to: z.string(),
  /** The delivery job's ID (the idempotency key). */
  jobId: z.string(),
});
export type SendTestEmailResult = z.infer<typeof sendTestEmailResultSchema>;

/** What an email is for: logged and counted, never the content (TDD §7.6). */
export const EMAIL_KINDS = ["invitation", "magic_link", "security_notice", "test"] as const;
export const emailKindSchema = z.enum(EMAIL_KINDS);
export type EmailKind = z.infer<typeof emailKindSchema>;

/** Delivery states in `email_deliveries` (Zod-validated, no CHECK; Platform §14). */
export const EMAIL_DELIVERY_STATES = ["queued", "sent", "failed", "dead"] as const;
export type EmailDeliveryState = (typeof EMAIL_DELIVERY_STATES)[number];

/**
 * The `email` queue message. `jobId` is the delivery job's ULID and the provider idempotency key. The
 * body carries the rendered email, links included, so it is never logged; only `jobId` and `kind` are.
 */
export const emailSendMessage = defineMessage("email.send", {
  jobId: z.string().min(1).max(64),
  kind: emailKindSchema,
  to: z.email().max(254),
  /**
   * When the email's link stops working (a magic link after 15 minutes, an invitation after 7 days).
   * The consumer never sends, retries or dead-letters the job after it: the job fails as `expired`.
   */
  expiresAt: z.number().int().positive().optional(),
  subject: z.string().min(1).max(300),
  text: z.string().max(64 * 1024),
  html: z.string().max(64 * 1024),
});
export type EmailSendMessage = z.infer<typeof emailSendMessage>;

/** `GET /api/status/public`: what a signed-out page may know (Platform §15, Admin §8.2). */
export const publicStatusSchema = z.object({
  /** "Email me a sign-in link" is offered: email configured and `magic_link_enabled` on. */
  magicLinks: z.boolean(),
});
export type PublicStatus = z.infer<typeof publicStatusSchema>;
