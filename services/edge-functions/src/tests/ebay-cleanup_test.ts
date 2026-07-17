// US-1978 (AC2): the already-deleted predicate for the eBay cleanup verbs.
//
// DELETE offer / DELETE inventory_item are the two DESTRUCTIVE verbs in the eBay
// surface, and both can legitimately fail because the artifact is ALREADY GONE — a
// prior cleanup removed it, or eBay expired it. That is the DESIRED end state, so
// the routes reconcile instead of erroring (same shape as isOfferAlreadyEndedError
// on the end path).
//
// The predicate has to be tight in BOTH directions, which is why it earns its own
// test:
//   • too loose  → a transient 5xx or a rate-limit reads as "already gone", the
//     route reports ok, and the stale artifact silently survives while the seller
//     believes it was cleaned up.
//   • too strict → routine cleanup of an already-gone artifact 502s at the seller.
//
// ebay-client.ts constructs the supabase client at load → dummy env first (the
// same pattern as denim-content_test.ts).
import { assert } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { isAlreadyDeletedError, isAlreadyInProgramStateError } = await import(
  "../lib/ebay-client.ts"
);

Deno.test("US-1978: an already-gone artifact reconciles rather than erroring", () => {
  for (const msg of [
    "eBay 404: offer not found",
    "eBay 404: The offer does not exist",
    "400 Bad Request: no inventory item with that SKU",
    "eBay 400: Invalid SKU",
  ]) {
    assert(
      isAlreadyDeletedError(new Error(msg)),
      `should treat as already-deleted: ${msg}`,
    );
  }
});

Deno.test("US-1978: a real failure is NEVER swallowed as already-deleted", () => {
  // The dangerous direction. If any of these read as "already gone", the route
  // tells the seller the artifact was cleaned up while it is still sitting there.
  for (const msg of [
    "eBay 500: Internal Server Error",
    "eBay 503: Service Unavailable",
    "eBay 429: rate limit exceeded",
    "eBay 403: insufficient permissions",
    "network timeout",
    "eBay 409: offer is published and cannot be deleted",
  ]) {
    assert(
      !isAlreadyDeletedError(new Error(msg)),
      `must NOT be swallowed as already-deleted: ${msg}`,
    );
  }
});

Deno.test("US-1978: the status code alone is necessary, not sufficient", () => {
  assert(
    !isAlreadyDeletedError(new Error("eBay 404: route not found on api.ebay.com")),
    "a 404 whose reason is unrelated to the artifact must not be swallowed",
  );
});

Deno.test("US-1978: non-Error inputs don't throw (catch sites pass `unknown`)", () => {
  assert(!isAlreadyDeletedError("something odd"), "a bare string is not already-deleted");
  assert(!isAlreadyDeletedError(null), "null is not already-deleted");
  assert(!isAlreadyDeletedError(undefined), "undefined is not already-deleted");
});

// ── US-1979 (AC3): the seller-program toggle's already-in-state predicate ───
//
// Same shape, same two-directional risk. eBay 409s an opt_in when the seller is
// already opted in — that is SUCCESS (they are in the state they asked for), and
// erroring would make the toggle look broken for doing nothing wrong. But swallow
// too much and a genuine rejection reads as "you're opted in" when you are not,
// which for OUT_OF_STOCK means the seller believes their evergreen listings
// survive qty 0 when eBay is still ending them.

Deno.test("US-1979: already-in-the-requested-state is success, not an error", () => {
  for (const msg of [
    "eBay 409: seller already opted in to OUT_OF_STOCK_CONTROL",
    "eBay 409: already enrolled",
    "eBay 400: not opted in to that program",
  ]) {
    assert(
      isAlreadyInProgramStateError(new Error(msg)),
      `should treat as already-in-state: ${msg}`,
    );
  }
});

Deno.test("US-1979: a real program failure is never swallowed", () => {
  // The dangerous direction: reporting opted_in when eBay refused means the seller
  // trusts their evergreen listings survive qty 0 while eBay keeps ending them.
  for (const msg of [
    "eBay 403: account not eligible for this program",
    "eBay 500: Internal Server Error",
    "eBay 429: rate limit exceeded",
    "network timeout",
    "eBay 409: conflicting request in flight",
  ]) {
    assert(
      !isAlreadyInProgramStateError(new Error(msg)),
      `must NOT be swallowed as already-in-state: ${msg}`,
    );
  }
  assert(!isAlreadyInProgramStateError("nope"), "a bare string is not evidence");
  assert(!isAlreadyInProgramStateError(null), "null is not evidence");
});
