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
}

interface InstallationRow {
  name: string;
  canonical_origin: string | null;
  allowed_hosts: string | null;
  setup_claim: string | null;
  setup_claimed_at: number | null;
  setup_completed_at: number | null;
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
      `SELECT name, canonical_origin, allowed_hosts, setup_claim, setup_claimed_at, setup_completed_at
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
  };
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
