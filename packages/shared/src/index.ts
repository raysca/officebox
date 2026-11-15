/**
 * `@officebox/shared`: types and Zod schemas shared by the Worker and the web app.
 *
 * ## How features define schemas
 *
 * - **One module per feature**, `src/<feature>.ts` (for example `src/chat.ts`), re-exported here. Core
 *   modules (`result`, `errors`, `envelope`, `health`) hold only cross-feature types.
 * - **Schemas first, types inferred.** Export the Zod schema as `<name>Schema` and its type as
 *   `export type <Name> = z.infer<typeof <name>Schema>`. Never hand-write a type that a schema describes.
 * - **API bodies:** `<action><Resource>BodySchema` for requests (for example `createChannelBodySchema`)
 *   and `<resource>Schema` for responses. Request schemas are `z.strictObject` so unknown fields are
 *   refused; response schemas are `z.object` so older clients tolerate added fields (expand/contract).
 * - **WebSocket and queue messages** use `defineMessage("<feature>.<verb>", { ...payload })` and are
 *   grouped per socket or queue with `defineMessageSet([...])`. Type names are lowercase and dotted.
 * - **Limits live in the schema** (`.max()`, byte caps) and as exported constants when the UI needs them
 *   too, for example `MAX_MESSAGE_BODY_BYTES`. Platform §8 structural limits are enforced here first.
 * - **Growable enums** (kinds, states) are `z.enum([...])` here, never SQL `CHECK`s (Platform §14).
 * - **IDs** are ULID strings (`ulidSchema`), timestamps are UTC epoch milliseconds (`z.number().int()`),
 *   and calendar dates are `YYYY-MM-DD` strings with an IANA time zone (AGENTS §4.1).
 * - **Errors** are `ApiError` values with an `ErrorCode`; add a code to `ERROR_CODES` rather than
 *   inventing strings. Validation failures use `validationError(zodError)`.
 * - Schemas are environment-neutral: no Workers or DOM APIs in this package.
 */
export * from "./result";
export * from "./errors";
export * from "./ids";
export * from "./envelope";
export * from "./health";
export * from "./security";
export * from "./permissions";
