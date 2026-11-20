import { z } from "zod";
import { Database, expectOk } from "../../core/db";

/**
 * The installation row's identity state (TDD §2.1, §6.8; Identity §2 "Canonical origin").
 *
 * The **canonical origin** and **allowed hosts** are workspace state written at the setup claim (and,
 * from M1c, by the owner's domain move), never deployment configuration (AGENTS §4.1) and never taken
 * from a request's `Host`. better-auth's `baseURL` and `trustedOrigins`, the passkey `rpID` and
 * `origin`, the CSRF `Origin` check and every emailed link come from it.
 *
 * Read from the D1 primary on every request that needs it (one row, no cache), so a claim or a domain
 * move takes effect at once.
 */

export interface Installation {
  workspaceName: string;
  /** Null until setup is claimed. */
  canonicalOrigin: string | null;
  /** Hosts (host[:port]) that redirect to the canonical origin; includes the canonical host itself. */
  allowedHosts: string[];
  setupClaim: string | null;
  setupClaimedAt: number | null;
  setupCompletedAt: number | null;
  /** The two-step domain move (M1c; Identity §4.4): started, not yet committed. Null when none. */
  pendingMove: PendingMove | null;
}

export interface PendingMove {
  origin: string;
  startedBy: string | null;
  expiresAt: number;
}

interface InstallationRow {
  name: string;
  canonical_origin: string | null;
  allowed_hosts: string | null;
  setup_claim: string | null;
  setup_claimed_at: number | null;
  setup_completed_at: number | null;
  pending_origin: string | null;
  pending_origin_started_by: string | null;
  pending_origin_expires_at: number | null;
}

const hostListSchema = z.array(z.string());

function parseHosts(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = hostListSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** The installation row, or null before any request has created it. */
export async function loadInstallation(db: D1Database): Promise<Installation | null> {
  const row = expectOk(
    await new Database(db).first<InstallationRow>(
      `SELECT name, canonical_origin, allowed_hosts, setup_claim, setup_claimed_at, setup_completed_at,
              pending_origin, pending_origin_started_by, pending_origin_expires_at
         FROM installation WHERE id = 1`,
    ),
  );
  if (!row) return null;
  return {
    workspaceName: row.name,
    canonicalOrigin: row.canonical_origin,
    allowedHosts: parseHosts(row.allowed_hosts),
    setupClaim: row.setup_claim,
    setupClaimedAt: row.setup_claimed_at,
    setupCompletedAt: row.setup_completed_at,
    pendingMove:
      row.pending_origin && row.pending_origin_expires_at !== null
        ? {
            origin: row.pending_origin,
            startedBy: row.pending_origin_started_by,
            expiresAt: row.pending_origin_expires_at,
          }
        : null,
  };
}

/**
 * How long a page request may use an isolate's cached installation row (M1c). Only the page middleware
 * uses it (the old-host redirect after a domain move); every API request still reads the row. A commit
 * clears this isolate's copy at once; other isolates catch up within the TTL, serving pages (not the API)
 * on the old host for at most that long **(default)**.
 */
export const PAGE_INSTALLATION_TTL_MS = 30_000;

const pageCache = new WeakMap<D1Database, { expiresAt: number; value: Installation | null }>();

/** The installation row for a page request, from this isolate's cache when it's fresh. */
export async function loadInstallationForPages(db: D1Database, now: number): Promise<Installation | null> {
  const hit = pageCache.get(db);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await loadInstallation(db);
  pageCache.set(db, { expiresAt: now + PAGE_INSTALLATION_TTL_MS, value });
  return value;
}

/** Forgets this isolate's cached row (a committed domain move; tests). */
export function clearPageInstallationCache(db: D1Database): void {
  pageCache.delete(db);
}

/** The pending domain move, if one is waiting and hasn't expired at `now`. */
export function activePendingMove(installation: Installation | null, now: number): PendingMove | null {
  const pending = installation?.pendingMove ?? null;
  return pending && pending.expiresAt > now ? pending : null;
}

/** An installation with a canonical origin: the shape better-auth is configured from. */
export interface ClaimedInstallation {
  workspaceName: string;
  canonicalOrigin: string;
}

export function claimed(installation: Installation | null): ClaimedInstallation | null {
  if (!installation?.canonicalOrigin) return null;
  return { workspaceName: installation.workspaceName, canonicalOrigin: installation.canonicalOrigin };
}
