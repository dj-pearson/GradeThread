// Unit tests for the marketplace connection health console core (US-897).
//
// deriveHealth/toConnectionHealth are pure, so the classification rules and —
// critically — the guarantee that encrypted tokens never reach the client (AC2)
// are verifiable without a DB.
//
//   deno test src/tests/admin-marketplace-connections_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  deriveHealth,
  EXPIRING_WINDOW_MS,
  type RawConnectionRow,
  toConnectionHealth,
} from "../lib/marketplace-health.ts";

const NOW = Date.parse("2026-06-14T00:00:00Z");

function row(over: Partial<RawConnectionRow> = {}): RawConnectionRow {
  return {
    id: "c1",
    user_id: "u1",
    marketplace: "ebay",
    account_handle: "seller_handle",
    token_expires_at: new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30d out
    last_synced_at: "2026-06-13T00:00:00Z",
    last_refresh_attempt_at: "2026-06-13T00:00:00Z",
    refresh_error: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-06-13T00:00:00Z",
    ...over,
  };
}

Deno.test("deriveHealth: healthy when active, no error, token far in the future", () => {
  assertEquals(deriveHealth(row(), NOW), "healthy");
});

Deno.test("deriveHealth: expiring when the token is within the window", () => {
  const soon = new Date(NOW + EXPIRING_WINDOW_MS - 1000).toISOString();
  assertEquals(deriveHealth(row({ token_expires_at: soon }), NOW), "expiring");
});

Deno.test("deriveHealth: expiring when expiry is unknown/unparseable on an active row", () => {
  assertEquals(deriveHealth(row({ token_expires_at: null }), NOW), "expiring");
});

Deno.test("deriveHealth: error when a refresh_error is present (even if also inactive)", () => {
  // A permanent refresh failure deactivates AND records refresh_error — that row
  // must read as 'error' (needs reconnect), not 'inactive'.
  assertEquals(
    deriveHealth(row({ refresh_error: "invalid_grant", is_active: false }), NOW),
    "error",
  );
});

Deno.test("deriveHealth: inactive when deactivated with no error", () => {
  assertEquals(deriveHealth(row({ is_active: false, refresh_error: null }), NOW), "inactive");
});

Deno.test("toConnectionHealth NEVER returns encrypted token fields (AC2)", () => {
  // Feed a row that DOES carry the encrypted tokens — the sanitizer must drop them.
  const dto = toConnectionHealth(
    row({
      access_token_encrypted: "SECRET-ACCESS-TOKEN",
      refresh_token_encrypted: "SECRET-REFRESH-TOKEN",
    }),
    NOW,
  );

  const keys = Object.keys(dto);
  assert(!keys.includes("access_token_encrypted"), "access token leaked into DTO");
  assert(!keys.includes("refresh_token_encrypted"), "refresh token leaked into DTO");
  // And no value anywhere in the serialized DTO contains the secrets.
  const serialized = JSON.stringify(dto);
  assert(!serialized.includes("SECRET-ACCESS-TOKEN"));
  assert(!serialized.includes("SECRET-REFRESH-TOKEN"));

  // The health metadata the console needs IS present.
  assertEquals(dto.marketplace, "ebay");
  assertEquals(dto.account_handle, "seller_handle");
  assertEquals(dto.health, "healthy");
  assert(typeof dto.token_expires_at === "string");
});
