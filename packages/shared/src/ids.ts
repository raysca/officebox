import { z } from "zod";

/** Crockford base32 ULID: 26 characters, 48-bit millisecond time then 80 random bits. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const ulidSchema = z.string().regex(ULID_PATTERN, "Expected a ULID.");
