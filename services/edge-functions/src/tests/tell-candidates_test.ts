// US-2147: reviewer tells → brand-knowledge candidates. Pure ranking logic.

// tell-candidates imports brand-authenticity, which transitively loads the
// service-role supabase client, so set dummy env first and dynamic-import
// (mirrors ai-authenticity_test.ts).
import { assert, assertEquals } from "@std/assert";
import type { ReviewTellObservation } from "../lib/tell-candidates.ts";

Deno.env.set("SUPABASE_URL", "https://example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "dummy");

const {
  draftTellFromCandidate,
  isPromotable,
  MIN_OBSERVATIONS,
  rankTellCandidates,
} = await import("../lib/tell-candidates.ts");

const obs = (
  brand: string,
  verdict: string,
  tells: string[],
): ReviewTellObservation => ({ brand_key: brand, reviewer_verdict: verdict, tells_relied_on: tells });

Deno.test("counts observations per brand+category and keeps brands separate", () => {
  const out = rankTellCandidates([
    obs("gucci", "counterfeit", ["date_code", "stitching"]),
    obs("gucci", "counterfeit", ["date_code"]),
    obs("coach", "counterfeit", ["date_code"]),
  ]);
  const gucciDate = out.find((c) => c.brand_key === "gucci" && c.category === "date_code");
  assertEquals(gucciDate?.observations, 2);
  // A tell proven on Gucci says nothing about Coach.
  assertEquals(out.find((c) => c.brand_key === "coach")?.observations, 1);
});

Deno.test("discrimination separates a deciding tell from one reviewers merely look at", () => {
  const out = rankTellCandidates([
    // date_code only ever decides counterfeits — one-directional.
    obs("gucci", "counterfeit", ["date_code"]),
    obs("gucci", "counterfeit", ["date_code"]),
    obs("gucci", "counterfeit", ["date_code"]),
    // stitching shows up on both verdicts about equally — reviewers look at it,
    // it does not separate real from fake.
    obs("gucci", "counterfeit", ["stitching"]),
    obs("gucci", "authentic", ["stitching"]),
    obs("gucci", "authentic", ["stitching"]),
  ]);
  const date = out.find((c) => c.category === "date_code")!;
  const stitch = out.find((c) => c.category === "stitching")!;

  assertEquals(date.discrimination, 1);
  assertEquals(date.leans, "counterfeit");
  assert(isPromotable(date));

  assert(stitch.discrimination < 0.7);
  assertEquals(stitch.leans, "mixed");
  assertEquals(isPromotable(stitch), false, "a non-discriminating tell must not be promotable");
});

Deno.test("inconclusive reviews are ignored entirely", () => {
  // A tell relied on to reach "I can't tell" is evidence about neither
  // direction; counting it would dilute the categories that decided something.
  const out = rankTellCandidates([
    obs("gucci", "inconclusive", ["date_code"]),
    obs("gucci", "inconclusive", ["date_code"]),
  ]);
  assertEquals(out.length, 0);
});

Deno.test("unknown tell categories are dropped, not coerced to 'other'", () => {
  // Coercing junk to 'other' is how the legacy {tell, detail} rows ended up
  // contributing nothing — a bucket of unrelated observations.
  const out = rankTellCandidates([obs("gucci", "counterfeit", ["vibes", "date_code"])]);
  assertEquals(out.length, 1);
  assertEquals(out[0].category, "date_code");
});

Deno.test("one reviewer's habit does not clear the observation floor", () => {
  const out = rankTellCandidates([obs("gucci", "counterfeit", ["hardware"])]);
  assertEquals(out[0].discrimination, 1, "perfectly directional…");
  assertEquals(isPromotable(out[0]), false, "…but a single observation is not evidence");
  assert(MIN_OBSERVATIONS > 1);
});

Deno.test("ranking puts the best-supported candidate first", () => {
  const out = rankTellCandidates([
    obs("gucci", "counterfeit", ["hardware"]),
    obs("gucci", "counterfeit", ["date_code"]),
    obs("gucci", "counterfeit", ["date_code"]),
    obs("gucci", "counterfeit", ["date_code"]),
  ]);
  assertEquals(out[0].category, "date_code");
});

Deno.test("the drafted tell asks a human to write it, and never invents prose", () => {
  const [c] = rankTellCandidates([
    obs("gucci", "counterfeit", ["date_code"]),
    obs("gucci", "counterfeit", ["date_code"]),
    obs("gucci", "counterfeit", ["date_code"]),
  ]);
  const draft = draftTellFromCandidate(c);

  assert(draft.claim.includes("TO WRITE"), "must not manufacture a ground-truth claim");
  assert(draft.check.includes("TO WRITE"));
  assert(draft.redFlag?.includes("TO WRITE"), "counterfeit-leaning candidates get a red-flag slot");
  // Confidence starts at the floor: an aggregate is a reason to look, not a
  // measure of how discriminating the written tell will be.
  assertEquals(draft.confidence, 0.5);
  assert(draft.source.startsWith("review-aggregate:"), "provenance is explicit");
});

Deno.test("an authentic-leaning candidate gets no redFlag slot", () => {
  const [c] = rankTellCandidates([
    obs("gucci", "authentic", ["stamp"]),
    obs("gucci", "authentic", ["stamp"]),
    obs("gucci", "authentic", ["stamp"]),
  ]);
  assertEquals(c.leans, "authentic");
  assertEquals(draftTellFromCandidate(c).redFlag, undefined);
});
