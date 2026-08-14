// US-2563: Idempotency-Key on the public API.
//
// The decision table is where this feature lives or dies, and three of its four
// outcomes only happen under concurrency or client error — which is exactly the
// set nobody exercises by hand. decideOnExistingClaim() is pure so all four are
// reachable without a database, a second in-flight request, or a dead container.
//
// The mounting and ordering facts (this must run after the auth middleware that
// sets userId, and before the usage middleware that would otherwise bill a
// replay) are properties of main.ts's arrangement, so they are asserted against
// the source — same idiom as account-erasure-order_test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ClaimDecision,
  decideOnExistingClaim,
  IN_FLIGHT_TTL_MS,
  sha256Hex,
} from "../middleware/api-idempotency.ts";

const FP = "a".repeat(64);
const OTHER_FP = "b".repeat(64);
const NOW = Date.parse("2026-08-14T12:00:00.000Z");

function claim(over: Partial<Parameters<typeof decideOnExistingClaim>[0]> = {}) {
  return {
    request_fingerprint: FP,
    state: "in_progress",
    response_status: null as number | null,
    response_body: null as unknown,
    created_at: new Date(NOW - 1_000).toISOString(),
    ...over,
  };
}

Deno.test("a completed claim with the same body replays the stored response", () => {
  const d = decideOnExistingClaim(
    claim({
      state: "completed",
      response_status: 202,
      response_body: { data: { id: "sub-1", status: "processing" }, error: null, meta: null },
    }),
    FP,
    NOW,
  );
  assertEquals(d.kind, "replay");
  if (d.kind !== "replay") return;
  assertEquals(d.status, 202);
  assertEquals(
    (d.body as { data: { id: string } }).data.id,
    "sub-1",
    "the replay must return the ORIGINAL response — a fresh one would mean the " +
      "handler ran, which is the charge this prevents",
  );
});

Deno.test("a completed claim with no stored status falls back to 200, not 0", () => {
  const d = decideOnExistingClaim(
    claim({ state: "completed", response_status: null, response_body: { ok: true } }),
    FP,
    NOW,
  );
  assertEquals(d.kind, "replay");
  if (d.kind !== "replay") return;
  assertEquals(d.status, 200);
});

Deno.test("a DIFFERENT body on the same key is a mismatch, not a replay", () => {
  // This ordering is the point: the fingerprint is checked BEFORE the completed
  // branch. A client that recycled one key across two garments must be told,
  // never handed the first garment's grade — that failure is wrong rather than
  // merely expensive, which makes it worse than the double charge.
  const d = decideOnExistingClaim(
    claim({ state: "completed", response_status: 202, response_body: { data: { id: "sub-1" } } }),
    OTHER_FP,
    NOW,
  );
  assertEquals(d.kind, "fingerprint_mismatch");
});

Deno.test("an in-flight claim inside the TTL conflicts", () => {
  const d = decideOnExistingClaim(
    claim({ created_at: new Date(NOW - (IN_FLIGHT_TTL_MS - 1_000)).toISOString() }),
    FP,
    NOW,
  );
  assertEquals(d.kind, "conflict");
});

Deno.test("an in-flight claim PAST the TTL is takeable", () => {
  // A container that died mid-handler must not lock a key out for the full 24h
  // retention window; the client's retry has to be able to make progress.
  const d = decideOnExistingClaim(
    claim({ created_at: new Date(NOW - (IN_FLIGHT_TTL_MS + 1_000)).toISOString() }),
    FP,
    NOW,
  );
  assertEquals(d.kind, "takeover");
});

Deno.test("the TTL boundary is exclusive — exactly TTL old is takeable", () => {
  const d = decideOnExistingClaim(
    claim({ created_at: new Date(NOW - IN_FLIGHT_TTL_MS).toISOString() }),
    FP,
    NOW,
  );
  assertEquals(d.kind, "takeover");
});

Deno.test("an UNPARSEABLE created_at conflicts rather than being taken over", () => {
  // NaN comparisons are false, so a naive `age >= ttl` would read a corrupt
  // timestamp as stale and hand the same claim to two callers — the precise
  // outcome this middleware exists to prevent. It has to fail closed.
  const d: ClaimDecision = decideOnExistingClaim(
    claim({ created_at: "not-a-date" }),
    FP,
    NOW,
  );
  assertEquals(d.kind, "conflict");
});

Deno.test("the fingerprint is a stable SHA-256 of the raw body", async () => {
  const body = JSON.stringify({ garment_type: "tops", title: "Tee" });
  const a = await sha256Hex(body);
  const b = await sha256Hex(body);
  assertEquals(a, b);
  assertEquals(a.length, 64);
  // Whitespace changes the bytes on the wire, so it changes the fingerprint.
  // That is correct and worth pinning: two byte-different requests are two
  // requests, and treating them as one would replay the wrong response.
  const spaced = await sha256Hex(JSON.stringify({ garment_type: "tops", title: "Tee" }, null, 2));
  assert(a !== spaced);
});

// ── Mounting facts, asserted against main.ts ─────────────────────────────────

async function mainSource(): Promise<string> {
  return await Deno.readTextFile(new URL("../main.ts", import.meta.url));
}

Deno.test("the middleware is mounted on /api/v1/* AFTER auth and BEFORE usage", async () => {
  const src = await mainSource();
  const auth = src.indexOf('app.use("/api/v1/*", apiKeyAuthMiddleware)');
  const idem = src.indexOf('app.use("/api/v1/*", apiIdempotencyMiddleware)');
  const usage = src.indexOf('app.use("/api/v1/*", apiUsageMiddleware)');

  assert(auth !== -1, "apiKeyAuthMiddleware mount not found — this guard is stale");
  assert(idem !== -1, "apiIdempotencyMiddleware is not mounted on /api/v1/*");
  assert(usage !== -1, "apiUsageMiddleware mount not found — this guard is stale");

  assert(
    auth < idem,
    "idempotency must mount AFTER apiKeyAuthMiddleware — it scopes its records " +
      "by the userId that middleware sets, and would key everything to undefined.",
  );
  assert(
    idem < usage,
    "idempotency must mount BEFORE apiUsageMiddleware. A replay returns without " +
      "calling next(), so the usage ledger correctly skips it; mounted the other " +
      "way round, every replay would be logged as a billable call — the usage " +
      "meter would count exactly the retries the replay makes free.",
  );
});

Deno.test("the rate limiter still runs before idempotency", async () => {
  // A flood of retries should be shed by the limiter, not turned into a write
  // per request against the idempotency table.
  const src = await mainSource();
  const writeLimiter = src.indexOf('"api-v1-write"');
  const idem = src.indexOf('app.use("/api/v1/*", apiIdempotencyMiddleware)');
  assert(writeLimiter !== -1 && writeLimiter < idem);
});

Deno.test("the OpenAPI spec documents the header and both failure codes", async () => {
  const spec = await Deno.readTextFile(
    new URL("../lib/openapi-spec.ts", import.meta.url),
  );
  assertStringIncludes(spec, "Idempotency-Key");
  assertStringIncludes(spec, "IDEMPOTENCY_IN_PROGRESS");
  assertStringIncludes(spec, "IDEMPOTENCY_KEY_REUSED");
  assertStringIncludes(spec, "Idempotent-Replay");
  // The retention window is a promise to integrators, not an internal detail.
  assertStringIncludes(spec, "24 hours");
});

Deno.test("the retention job prunes the table", async () => {
  const retention = await Deno.readTextFile(
    new URL("../lib/data-retention.ts", import.meta.url),
  );
  assertStringIncludes(
    retention,
    "prune_api_idempotency_records",
    "api_idempotency_records is written once per mutating /api/v1 call. Without " +
      "a prune it is the same unbounded-growth defect US-2021 found in " +
      "email_deliveries.",
  );
});
