// US-359: log redaction + standardized error-response unit tests.
import { assert, assertEquals } from "@std/assert";
import { redact, redactError } from "../lib/log-redact.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";

Deno.test("redact scrubs JWTs", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.s5dSh_signaturePart";
  const out = redact(`token=${jwt} done`);
  assert(!out.includes("eyJhbGci"), out);
  assert(out.includes("[redacted:jwt]"), out);
});

Deno.test("redact scrubs Bearer tokens, stripe keys, api keys, emails", () => {
  const out = redact(
    "Bearer abc.def-123 sk_live_ABCDEFGH12345678 whsec_ZZZZZZZZ1234 gt_abcdef0123456789 user jane.doe@example.com",
  );
  assert(out.includes("Bearer [redacted]"), out);
  assert(out.includes("[redacted:key]"), out);
  assert(out.includes("[redacted:whsec]"), out);
  assert(out.includes("[redacted:apikey]"), out);
  assert(out.includes("[redacted:email]"), out);
  assert(!out.includes("jane.doe@example.com"), out);
  assert(!out.includes("sk_live_ABCDEFGH12345678"), out);
});

Deno.test("redact scrubs long signature/base64 blobs", () => {
  const sig = "a".repeat(60) + "==";
  const out = redact(`x-ebay-signature: ${sig}`);
  assert(out.includes("[redacted:blob]"), out);
  assert(!out.includes(sig), out);
});

Deno.test("redact leaves benign text intact", () => {
  assertEquals(redact("Suggestion not found"), "Suggestion not found");
});

Deno.test("redactError formats Error name+message and scrubs it", () => {
  const out = redactError(new Error("duplicate key for bob@x.com"));
  assert(out.startsWith("Error: "), out);
  assert(out.includes("[redacted:email]"), out);
});

// ── error helpers (mock Hono context) ───────────────────────────────────────

type Recorded = { body: unknown; status: number };

function mockContext(): { c: unknown; last: () => Recorded } {
  let rec: Recorded = { body: null, status: 0 };
  const c = {
    json(body: unknown, status: number) {
      rec = { body, status };
      return { body, status } as unknown as Response;
    },
  };
  return { c, last: () => rec };
}

Deno.test("jsonError returns {error} and optional {code}", () => {
  const { c, last } = mockContext();
  jsonError(c as never, 404, "Suggestion not found");
  assertEquals(last().status, 404);
  assertEquals(last().body, { error: "Suggestion not found" });

  jsonError(c as never, 402, "Plan required", "FEATURE_LOCKED");
  assertEquals(last().body, { error: "Plan required", code: "FEATURE_LOCKED" });
});

Deno.test("failSafe returns a generic body and NEVER the raw cause", () => {
  const { c, last } = mockContext();
  const raw = new Error("relation \"users\" violates RLS for jane@x.com");
  const original = console.error;
  let logged = "";
  console.error = (...a: unknown[]) => {
    logged = a.join(" ");
  };
  try {
    failSafe(c as never, 500, "Couldn't load profile.", raw, "verified.get");
  } finally {
    console.error = original;
  }
  // Client body is generic — no schema/PII.
  assertEquals(last().body, { error: "Couldn't load profile." });
  assertEquals(last().status, 500);
  // Server log is tagged and redacted (no raw email).
  assert(logged.includes("[verified.get]"), logged);
  assert(!logged.includes("jane@x.com"), logged);
});
