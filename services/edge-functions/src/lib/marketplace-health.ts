// US-897: Marketplace connection health — pure derivation + sanitization.
//
// Kept dependency-free (no Supabase, no Date.now() inside the pure core) so the
// health-classification rules and — critically — the guarantee that encrypted
// tokens are NEVER serialized to the client (AC2) are unit-testable without a DB.
//
//   deno test src/tests/admin-marketplace-connections_test.ts

/** Derived, operator-facing health of a marketplace OAuth connection. */
export type ConnectionHealth = "healthy" | "expiring" | "error" | "inactive";

export const VALID_HEALTH: ReadonlySet<ConnectionHealth> = new Set([
  "healthy",
  "expiring",
  "error",
  "inactive",
]);

/** A connection that's healthy if its token expires more than this far out. */
export const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The raw row shape. The encrypted-token fields are declared OPTIONAL here only
// so the sanitizer test can prove they're dropped even when present — the route
// never SELECTs them in the first place.
export interface RawConnectionRow {
  id: string;
  user_id: string;
  marketplace: string;
  account_handle: string | null;
  token_expires_at: string | null;
  last_synced_at: string | null;
  last_refresh_attempt_at: string | null;
  refresh_error: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // NEVER returned to the client — present only to prove the sanitizer omits them.
  access_token_encrypted?: string | null;
  refresh_token_encrypted?: string | null;
}

/** The sanitized DTO returned to the admin client — no token material. */
export interface ConnectionHealthDTO {
  id: string;
  user_id: string;
  marketplace: string;
  account_handle: string | null;
  token_expires_at: string | null;
  last_synced_at: string | null;
  last_refresh_attempt_at: string | null;
  refresh_error: string | null;
  is_active: boolean;
  health: ConnectionHealth;
  created_at: string;
  updated_at: string;
}

// Classify a connection. Order matters: a permanent refresh failure deactivates
// the connection AND stores a refresh_error (see getUserAccessToken), so the
// refresh_error check must come first — that row is "error" (needs reconnect),
// not merely "inactive".
export function deriveHealth(
  row: RawConnectionRow,
  nowMs: number,
  windowMs: number = EXPIRING_WINDOW_MS,
): ConnectionHealth {
  if (row.refresh_error) return "error";
  if (!row.is_active) return "inactive";
  const exp = row.token_expires_at ? Date.parse(row.token_expires_at) : NaN;
  // Unknown/unparseable expiry on an active connection → treat as expiring so an
  // operator gives it attention rather than silently trusting it.
  if (!Number.isFinite(exp)) return "expiring";
  if (exp <= nowMs + windowMs) return "expiring";
  return "healthy";
}

// Build the client DTO field-by-field — this is the single choke point that
// guarantees no encrypted token ever reaches the client (AC2), regardless of
// what columns the caller happened to select.
export function toConnectionHealth(
  row: RawConnectionRow,
  nowMs: number,
  windowMs: number = EXPIRING_WINDOW_MS,
): ConnectionHealthDTO {
  return {
    id: row.id,
    user_id: row.user_id,
    marketplace: row.marketplace,
    account_handle: row.account_handle ?? null,
    token_expires_at: row.token_expires_at ?? null,
    last_synced_at: row.last_synced_at ?? null,
    last_refresh_attempt_at: row.last_refresh_attempt_at ?? null,
    refresh_error: row.refresh_error ?? null,
    is_active: row.is_active,
    health: deriveHealth(row, nowMs, windowMs),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
