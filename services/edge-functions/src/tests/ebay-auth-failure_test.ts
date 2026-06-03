// US-463: permanent-vs-transient eBay token-refresh failure classification.
//
// isPermanentEbayAuthFailure is pure. ebay-client.ts imports the service-role
// supabase client at load, so set dummy env BEFORE the dynamic import.
//
//   deno test --allow-env src/tests/ebay-auth-failure_test.ts
import { assert } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { isPermanentEbayAuthFailure } = await import("../lib/ebay-client.ts");

// refreshUserToken throws: `eBay token refresh failed (NNN): <body>`
const refreshErr = (status: number, body: string) =>
  new Error(`eBay token refresh failed (${status}): ${body}`);

Deno.test("invalid_grant (revoked/expired refresh token) is permanent", () => {
  assert(
    isPermanentEbayAuthFailure(
      refreshErr(400, '{"error":"invalid_grant","error_description":"refresh token expired"}'),
    ),
  );
});

Deno.test("invalid_client / unauthorized_client are permanent", () => {
  assert(isPermanentEbayAuthFailure(refreshErr(401, '{"error":"invalid_client"}')));
  assert(isPermanentEbayAuthFailure(refreshErr(400, '{"error":"unauthorized_client"}')));
});

Deno.test("a bare 400/401/403 with no recognizable body is still permanent", () => {
  assert(isPermanentEbayAuthFailure(refreshErr(400, "Bad Request")));
  assert(isPermanentEbayAuthFailure(refreshErr(401, "Unauthorized")));
  assert(isPermanentEbayAuthFailure(refreshErr(403, "Forbidden")));
});

Deno.test("5xx and 429 are TRANSIENT (do not deactivate)", () => {
  assert(!isPermanentEbayAuthFailure(refreshErr(500, "Internal Server Error")));
  assert(!isPermanentEbayAuthFailure(refreshErr(503, "Service Unavailable")));
  assert(!isPermanentEbayAuthFailure(refreshErr(429, "Too Many Requests")));
});

Deno.test("network/timeout errors are TRANSIENT", () => {
  assert(!isPermanentEbayAuthFailure(new TypeError("error sending request for url (timeout)")));
  assert(!isPermanentEbayAuthFailure(new Error("connection reset")));
});
