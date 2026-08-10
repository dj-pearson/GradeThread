import { assert, assertEquals } from "@std/assert";
import { crossCheckDecodeResult } from "../lib/brand-decoders.ts";

// ai-authenticity.ts loads the service-role supabase client at module scope, so
// its import is DEFERRED behind dummy env (the health_test pattern). A static
// import fails the whole file before a single test runs — which is a test file
// that proves nothing while looking like it exists.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { applyDecoderContradictionCap, AUTHENTICITY_CONTRADICTION_CONFIDENCE_CAP } =
  await import("../lib/ai-authenticity.ts");

// US-2138 AC6: a contradiction from a deterministic decoder must DOMINATE model
// optimism. The decision to enforce that as a cap rather than as prompt context
// is recorded in the story and in applyDecoderContradictionCap's own header —
// briefly, a prompt asks the model to WEIGH the contradiction, and a model can
// talk itself out of a fact.

Deno.test("a decoder contradiction caps a confident verdict", () => {
  // The case the AC is about: the model is sure, the code is impossible.
  assertEquals(
    applyDecoderContradictionCap(0.95, 1),
    AUTHENTICITY_CONTRADICTION_CONFIDENCE_CAP,
  );
});

Deno.test("the cap NEVER raises — an already-low verdict is left alone", () => {
  // Every cap in this file composes as a min. A cap that could raise would be a
  // decoder contradiction making the system MORE confident, which is absurd and
  // is exactly the shape a careless Math.max would produce.
  assertEquals(applyDecoderContradictionCap(0.2, 3), 0.2);
  assertEquals(applyDecoderContradictionCap(0, 1), 0);
});

Deno.test("no flags means no change at all", () => {
  for (const c of [0.99, 0.5, 0.31, 0]) {
    assertEquals(applyDecoderContradictionCap(c, 0), c, `${c} must pass through`);
  }
  assertEquals(applyDecoderContradictionCap(0.9, -1), 0.9);
});

Deno.test("⚠ ONLY server-derived checks produce the flag severity the cap acts on", () => {
  // THE INJECTION-DEFENCE PROPERTY (US-346), asserted rather than assumed.
  //
  // crossCheckDecodeResult can compare a decode against what the LISTING claims
  // — claimedYear, claimedGender, claimedStyleCode — all of which are seller
  // text. If any of those produced `flag`, a seller could cap their own
  // authenticity verdict by typing a wrong year, and untrusted input must never
  // move a score. This test is what stops a future contributor "upgrading" one
  // of those severities without realising what it unlocks.
  const decoded = {
    brand: "Test",
    year: "2999",
    gender: "mens",
    styleCode: "ABC123",
  } as Parameters<typeof crossCheckDecodeResult>[0];

  const sellerClaims = crossCheckDecodeResult(decoded, {
    claimedYear: 1990,
    claimedGender: "womens",
    claimedStyleCode: "ZZZ999",
  });
  assert(sellerClaims.length >= 3, "expected the three claim comparisons to fire");
  assertEquals(
    sellerClaims.filter((i) => i.severity === "flag").length,
    0,
    "a seller-claim mismatch must NEVER be `flag` — that severity is what caps " +
      "the verdict, so it would hand the seller a lever on their own result",
  );
});

Deno.test("an impossible date IS a flag, so the cap has something to act on", () => {
  // The other half: the guard above is only meaningful if a genuine
  // server-derived contradiction still reaches `flag`.
  const decoded = { brand: "Test", year: "2999" } as Parameters<
    typeof crossCheckDecodeResult
  >[0];
  const flags = crossCheckDecodeResult(decoded, { currentYear: 2026 })
    .filter((i) => i.severity === "flag");
  assertEquals(flags.length, 1);
  assertEquals(flags[0].code, "date_in_future");
});

Deno.test("the pipeline passes NO seller-claim context to the cross-check", () => {
  // Belt and braces, and a source scan because it is the CALL SITE that decides
  // this — the severity rule above protects the value, this protects the input.
  // Either alone would do; both are cheap and they fail for different reasons.
  const src = Deno.readTextFileSync(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  // Anchored on the CALL, not on the variable it assigns to. The first version
  // of this test keyed on `decoderFlagCount = crossCheckDecodeResult(` and broke
  // the moment that variable was renamed to carry the flag list — a guard that
  // fails on a rename tells you nothing about the property it guards.
  const start = src.indexOf("crossCheckDecodeResult(decoded, {");
  assert(start > -1, "the pipeline cross-check call is missing or renamed");
  const call = src.slice(start, src.indexOf("})", start));
  for (const claim of ["claimedYear", "claimedGender", "claimedStyleCode"]) {
    assert(
      !call.includes(claim),
      `the pipeline must not pass ${claim} — it is seller-supplied text and ` +
        "would let a seller influence their own authenticity verdict",
    );
  }
  assert(call.includes("currentYear"), "currentYear must still be supplied");
});

Deno.test("the pipeline caps only on flag severity", () => {
  const src = Deno.readTextFileSync(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  assert(
    /severity === "flag"/.test(src),
    "the pipeline must filter cross-check results to `flag` before capping — " +
      "counting `warn` would cap on seller-claim mismatches",
  );
});
