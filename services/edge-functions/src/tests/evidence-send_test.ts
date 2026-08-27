// US-2935: the rules every grade-evidence send shares.
//
// Three eBay surfaces take a pack — a return, a payment dispute, and an
// escalated case — and each has its own upload API. What must NOT vary is the
// decision about whether to send at all. Before this, each route carried its
// own copy of the refusal, and a copy is one place for it to go missing on the
// surface nobody exercises.
//
// The refusal is US-2703 AC5: when the grade report AGREES with the buyer, the
// pack is evidence for the other side, so it does not go.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { cleanEvidenceFiles, evidenceRefusalFor } = await import("../lib/evidence-send.ts");

Deno.test("a 'supported' verdict is refused, and carries eBay-free wording out", () => {
  const refusal = evidenceRefusalFor({
    verdict: "supported",
    reason: "Your report records the stain and the listing did not mention it.",
  });
  assert(refusal !== null);
  assertEquals(refusal!.verdict, "supported");
  assertEquals(refusal!.reason, "Your report records the stain and the listing did not mention it.");
});

Deno.test("a supported verdict with no reason still refuses, with a stated one", () => {
  // A refusal with an empty reason renders as a blank error, which reads like a
  // bug rather than a decision.
  const refusal = evidenceRefusalFor({ verdict: "supported", reason: null });
  assert(refusal !== null);
  assert(refusal!.reason.length > 0);
});

Deno.test("every other verdict sends", () => {
  assertEquals(evidenceRefusalFor({ verdict: "contradicted", reason: "x" }), null);
  assertEquals(evidenceRefusalFor({ verdict: "not_covered", reason: "x" }), null);
});

Deno.test("NO PLAN is not a refusal", () => {
  // The direction that matters. A lookup failure must never silently become a
  // refusal — the send then proceeds on the seller's own judgement, which is
  // what the return route's comment has always promised.
  assertEquals(evidenceRefusalFor(null), null);
  assertEquals(evidenceRefusalFor(undefined), null);
  assertEquals(evidenceRefusalFor({}), null);
});

// A one-pixel PNG, so the magic-byte sniff passes and the test exercises the
// real path rather than the rejection.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (ch) => ch.charCodeAt(0),
);

Deno.test("cleanEvidenceFiles rejects an empty set and an over-cap set", async () => {
  assertEquals((await cleanEvidenceFiles([], 6)).ok, false);
  const many = Array.from(
    { length: 7 },
    (_, i) => new File([PNG], `e${i}.png`, { type: "image/png" }),
  );
  const out = await cleanEvidenceFiles(many, 6);
  assertEquals(out.ok, false);
  assert(!out.ok && out.error.includes("6"));
});

Deno.test("cleanEvidenceFiles rejects a non-image whatever the client called it", async () => {
  // The sniff, not the MIME. A file the browser labels image/png is still not
  // one, and these go to a buyer-facing surface at eBay.
  const fake = new File([new Uint8Array([1, 2, 3, 4])], "evil.png", { type: "image/png" });
  const out = await cleanEvidenceFiles([fake], 6);
  assertEquals(out.ok, false);
  assert(!out.ok && out.error.startsWith("Invalid image"));
});

Deno.test("cleanEvidenceFiles names an unnamed file rather than sending a blank", async () => {
  const out = await cleanEvidenceFiles([new File([PNG], "", { type: "image/png" })], 6);
  assert(out.ok);
  assert(out.ok && out.files[0]!.filename.length > 0);
  assert(out.ok && out.files[0]!.contentType.includes("png"));
});
