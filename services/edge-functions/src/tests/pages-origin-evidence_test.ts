// US-2612: /health/ready must report whether the Cloudflare Pages half of the
// origin secret is armed, and it can only learn that by OBSERVING a request.
//
// The old line read the edge's own CF_PAGES_ORIGIN_SECRET and said, correctly,
// that it could not see the Pages project. That was permanently unactionable: a
// Pages value that is absent, or set to something different, is indistinguishable
// from a correct one when all you can read is your own env — so the line was
// going to say "one of the two halves" forever.
//
// A request carrying a matching x-pages-origin settles it. Only something
// holding the same secret can send that header.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Context } from "hono";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  QUIET_GRACE_MS,
  pagesOriginEvidenceLine,
  pagesOriginObservation,
  recordPagesOriginMatch,
  resetPagesOriginObservation,
} = await import("../lib/pages-origin-evidence.ts");
const { computeFeatureReadiness } = await import("../lib/env-validation.ts");
const { pagesOriginBypass, requirePagesOrigin } = await import(
  "../middleware/rate-limit.ts"
);

const BOOT = Date.parse("2026-08-17T12:00:00.000Z");

/** Only `c.req.header(name)` is touched by either matcher. */
function ctxWith(headers: Record<string, string>): Context {
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
  } as unknown as Context;
}

// ── The formatter ───────────────────────────────────────────────────────────

Deno.test("US-2612: inside the grace window, silence says nothing and the caveat stands", () => {
  // A freshly deployed container has seen nothing yet. Reporting that as a gap
  // would fire on EVERY deploy, which is how a line stops being read.
  const line = pagesOriginEvidenceLine(
    { lastMatchMs: null, matchCount: 0, bootMs: BOOT },
    BOOT + QUIET_GRACE_MS - 1,
  );
  assertEquals(line, null, "null means: keep the existing two-sided caveat");
});

Deno.test("US-2612: past the grace window, an unproven secret says so and how to check", () => {
  const line = pagesOriginEvidenceLine(
    { lastMatchMs: null, matchCount: 0, bootMs: BOOT },
    BOOT + 3 * 3600_000,
  );
  assert(line !== null);
  assertStringIncludes(line, "NOT YET PROVEN");
  assertStringIncludes(line, "3.0h", "it must state the window it is silent over");
  // The two readings are genuinely different and the line must not pick one:
  // a low-traffic hour and a broken Pages value look identical from here.
  assertStringIncludes(line, "genuine quiet");
  assertStringIncludes(line, "behaves exactly like no secret at all");
  // And it must say what to DO, or it is another unactionable line.
  assertStringIncludes(line, "fetch any blog post or certificate page");
});

Deno.test("US-2612: one matched request proves the other half, with its age", () => {
  const line = pagesOriginEvidenceLine(
    { lastMatchMs: BOOT + 3600_000, matchCount: 312, bootMs: BOOT },
    BOOT + 3600_000 + 4 * 60_000,
  );
  assert(line !== null);
  assertStringIncludes(line, "PROVEN FROM THE OTHER SIDE");
  assertStringIncludes(line, "312 request(s)");
  assertStringIncludes(line, "4m ago");
  assertStringIncludes(line, "Cloudflare Pages");
});

// ── The readiness line ──────────────────────────────────────────────────────

Deno.test("US-2612: evidence REPLACES the 'cannot tell the difference' caveat", () => {
  const env: Record<string, string> = {
    EDGE_ENV: "production",
    CF_PAGES_ORIGIN_SECRET: "s3cret",
  };
  const get = (k: string) => env[k];

  const withoutEvidence = String(computeFeatureReadiness(get).pages_origin_bypass);
  assertStringIncludes(withoutEvidence, "one of the two halves");
  assertStringIncludes(withoutEvidence, "cannot tell the difference");

  const withEvidence = String(
    computeFeatureReadiness(get, { pages_origin_bypass: "PROVEN FROM THE OTHER SIDE: yes." })
      .pages_origin_bypass,
  );
  assertStringIncludes(withEvidence, "ok — PROVEN FROM THE OTHER SIDE");
  // The whole point: once the line CAN tell, the sentence saying it cannot is
  // no longer merely redundant, it is false.
  assert(
    !withEvidence.includes("cannot tell the difference"),
    `the superseded caveat must be gone, got: ${withEvidence}`,
  );
});

Deno.test("US-2612: a null/absent evidence value leaves every line exactly as it was", () => {
  const env: Record<string, string> = {
    EDGE_ENV: "production",
    CF_PAGES_ORIGIN_SECRET: "s3cret",
  };
  const get = (k: string) => env[k];
  assertEquals(
    computeFeatureReadiness(get, { pages_origin_bypass: null }),
    computeFeatureReadiness(get),
  );
});

Deno.test("US-2612 REGRESSION: evidence cannot dress up a group that is NOT satisfied", () => {
  // A match is impossible without the secret, so this should never happen — but
  // the failure direction matters: a "PROVEN" line over a missing secret would
  // be the worst possible readiness output, so the code path is pinned rather
  // than argued about.
  const get = (k: string) => (k === "EDGE_ENV" ? "production" : undefined);
  const line = String(
    computeFeatureReadiness(get, { pages_origin_bypass: "PROVEN FROM THE OTHER SIDE: yes." })
      .pages_origin_bypass,
  );
  assertStringIncludes(line, "missing: CF_PAGES_ORIGIN_SECRET");
  assert(!line.includes("PROVEN"), `got: ${line}`);
});

// ── The wiring ──────────────────────────────────────────────────────────────
//
// The formatter is useless if nothing ever calls the recorder, and nothing about
// a missing call fails to compile.

Deno.test("US-2612: the rate-limit bypass records a match, and only a match", () => {
  Deno.env.set("CF_PAGES_ORIGIN_SECRET", "pages-s3cret");
  try {
    resetPagesOriginObservation(BOOT);
    assertEquals(pagesOriginBypass(ctxWith({ "x-pages-origin": "wrong" })), false);
    assertEquals(pagesOriginBypass(ctxWith({})), false);
    assertEquals(pagesOriginObservation().matchCount, 0, "a miss is not evidence");

    assertEquals(pagesOriginBypass(ctxWith({ "x-pages-origin": "pages-s3cret" })), true);
    const obs = pagesOriginObservation();
    assertEquals(obs.matchCount, 1);
    assert(obs.lastMatchMs !== null);
  } finally {
    Deno.env.delete("CF_PAGES_ORIGIN_SECRET");
    resetPagesOriginObservation();
  }
});

Deno.test("US-2612: the auth gate records too — same secret, different door", () => {
  // The OG render routes go through requirePagesOrigin, not the bypass. If only
  // one matcher recorded, a deploy whose SSR traffic is all OG images would read
  // as never proven.
  Deno.env.set("CF_PAGES_ORIGIN_SECRET", "pages-s3cret");
  try {
    resetPagesOriginObservation(BOOT);
    assertEquals(requirePagesOrigin(ctxWith({ "x-pages-origin": "nope" })), false);
    assertEquals(pagesOriginObservation().matchCount, 0);

    assertEquals(requirePagesOrigin(ctxWith({ "x-pages-origin": "pages-s3cret" })), true);
    assertEquals(pagesOriginObservation().matchCount, 1);
  } finally {
    Deno.env.delete("CF_PAGES_ORIGIN_SECRET");
    resetPagesOriginObservation();
  }
});

Deno.test("US-2612: an unset secret records nothing, so it can never read as proven", () => {
  Deno.env.delete("CF_PAGES_ORIGIN_SECRET");
  resetPagesOriginObservation(BOOT);
  assertEquals(pagesOriginBypass(ctxWith({ "x-pages-origin": "anything" })), false);
  assertEquals(requirePagesOrigin(ctxWith({ "x-pages-origin": "anything" })), false);
  assertEquals(pagesOriginObservation().matchCount, 0);
  resetPagesOriginObservation();
});

Deno.test("US-2612: recordPagesOriginMatch keeps the LATEST match, not the first", () => {
  resetPagesOriginObservation(BOOT);
  recordPagesOriginMatch(BOOT + 1000);
  recordPagesOriginMatch(BOOT + 9000);
  const obs = pagesOriginObservation();
  assertEquals(obs.matchCount, 2);
  assertEquals(obs.lastMatchMs, BOOT + 9000);
  resetPagesOriginObservation();
});
