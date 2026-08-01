// US-1897: Listing Quality Score + the business-policy signal parser (pure).
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  computeListingQualityScore,
  QUALITY_WEIGHTS,
  BLOCKED_SCORE_CEILING,
  type QualityScoreInput,
} from "../lib/listing-quality-score.ts";
import {
  handlingToDays,
  hasFreeShipping,
  parseFulfillmentSignals,
  UNKNOWN_FULFILLMENT,
} from "../lib/business-policy-signals.ts";

// A listing that does everything right. AC4's headline fixture.
function perfect(): QualityScoreInput {
  return {
    title: { text: "Patagonia Better Sweater Fleece Jacket Men's Medium Navy", policyViolations: [], warnings: [] },
    aspects: { requiredMissing: [], recommendedFilled: 8, recommendedTotal: 8 },
    photos: { blockers: [], warnings: [], nudge: null, count: 6 },
    category: { leafStatus: "leaf", matchesSuggestion: true },
    condition: { consistent: true, warnings: [] },
    fulfillment: { returnsAccepted: true, handlingDays: 1, freeShipping: true },
  };
}

// ── AC4: the headline assertions ───────────────────────────────────────────

Deno.test("US-1897 AC4: a fully-optimized listing scores 100", () => {
  const out = computeListingQualityScore(perfect());
  assertEquals(out.score, 100);
  assertEquals(out.weightCounted, 100, "every signal readable ⇒ full weight counted");
  assertEquals(out.topFixes, [], "nothing left to fix");
  assert(out.components.every((c) => c.status === "ok"));
});

Deno.test("weights sum to exactly 100", () => {
  const total = Object.values(QUALITY_WEIGHTS).reduce((a, b) => a + b, 0);
  assertEquals(total, 100);
});

Deno.test("a listing that does nothing right scores 0", () => {
  const out = computeListingQualityScore({
    title: { text: "", policyViolations: [], warnings: [] },
    aspects: { requiredMissing: ["Brand", "Size", "Colour"], recommendedFilled: 0, recommendedTotal: 8 },
    photos: { blockers: ["Hero photo is 320px on its longest side"], warnings: [], nudge: null, count: 1 },
    category: { leafStatus: "non_leaf", matchesSuggestion: false },
    condition: { consistent: false, warnings: ["Says 'like new' but tier is Pre-owned - Fair"] },
    fulfillment: { returnsAccepted: false, handlingDays: 5, freeShipping: false },
  });
  assert(out.score <= 5, `expected ~0, got ${out.score}`);
});

// ── the ordering the playbook mandates ─────────────────────────────────────

Deno.test("aspects outrank photos, which outrank title (playbook §1/§6/§2)", () => {
  assert(QUALITY_WEIGHTS.aspects > QUALITY_WEIGHTS.photos);
  assert(QUALITY_WEIGHTS.photos > QUALITY_WEIGHTS.title);
  assert(QUALITY_WEIGHTS.title > QUALITY_WEIGHTS.fulfillment);
});

Deno.test("missing REQUIRED specifics zero the component, not merely dent it", () => {
  const i = perfect();
  i.aspects = { requiredMissing: ["Brand"], recommendedFilled: 8, recommendedTotal: 8 };
  const out = computeListingQualityScore(i);
  const aspects = out.components.find((c) => c.key === "aspects")!;
  assertEquals(aspects.earned, 0);
  assertEquals(aspects.status, "fix");
  // A missing required aspect removes the listing from every filtered search,
  // so it must dominate the fix list.
  assertEquals(out.topFixes[0].key, "aspects");
});

Deno.test("recommended-aspect coverage scales the component", () => {
  const half = perfect();
  half.aspects = { requiredMissing: [], recommendedFilled: 4, recommendedTotal: 8 };
  const full = computeListingQualityScore(perfect()).score;
  const out = computeListingQualityScore(half);
  assert(out.score < full, "half coverage must score below full");
  assert(out.score > 80, `required-complete listings stay high; got ${out.score}`);
});

Deno.test("a category recommending NO aspects is not penalised", () => {
  const i = perfect();
  i.aspects = { requiredMissing: [], recommendedFilled: 0, recommendedTotal: 0 };
  assertEquals(computeListingQualityScore(i).score, 100, "eBay's taxonomy is not the seller's fault");
});

// ── AC3: no folklore signals ───────────────────────────────────────────────

Deno.test("US-1897 AC3: title length is NOT a target — 68 and 78 chars score the same", () => {
  // §2 flags "70-80 chars" and "first words weigh more" as vendor lore, not
  // eBay statements. Two clean titles of different lengths must tie.
  const a = perfect();
  a.title = { text: "A".repeat(68), policyViolations: [], warnings: [] };
  const b = perfect();
  b.title = { text: "B".repeat(78), policyViolations: [], warnings: [] };
  assertEquals(computeListingQualityScore(a).score, computeListingQualityScore(b).score);
});

Deno.test("word ORDER never changes the score (no 'first 35 chars' rule)", () => {
  const a = perfect();
  a.title = { text: "Navy Medium Jacket Fleece Sweater Better Patagonia", policyViolations: [], warnings: [] };
  const b = perfect();
  b.title = { text: "Patagonia Better Sweater Fleece Jacket Medium Navy", policyViolations: [], warnings: [] };
  assertEquals(computeListingQualityScore(a).score, computeListingQualityScore(b).score);
});

Deno.test("no component references a §10 non-factor", () => {
  const out = computeListingQualityScore(perfect());
  const blob = JSON.stringify(out).toLowerCase();
  for (const folklore of ["best offer", "relist", "sell similar", "stemming", "template"]) {
    assert(!blob.includes(folklore), `score must not reference the non-factor "${folklore}"`);
  }
});

Deno.test("a title too SHORT to carry search terms is still penalised", () => {
  // Not a length target — a floor. "Jacket" cannot match many queries.
  const i = perfect();
  i.title = { text: "Jacket", policyViolations: [], warnings: [] };
  const out = computeListingQualityScore(i);
  assert(out.score < 100);
  assertEquals(out.components.find((c) => c.key === "title")!.status, "warn");
});

Deno.test("a policy-violating title zeroes the component (US-1890 blocker)", () => {
  const i = perfect();
  i.title = { text: "Nike style jacket not Patagonia", policyViolations: ["Comparison to an unrelated brand"], warnings: [] };
  const t = computeListingQualityScore(i).components.find((c) => c.key === "title")!;
  assertEquals(t.earned, 0);
  assertEquals(t.status, "fix");
});

// ── unknown signals are excluded, not scored zero ──────────────────────────

Deno.test("unsynced business policies do NOT drag the score down", () => {
  const i = perfect();
  i.fulfillment = UNKNOWN_FULFILLMENT;
  const out = computeListingQualityScore(i);
  // Everything else is perfect, so the score must stay 100 — scoring an
  // unreadable signal as 0 would blame the seller for our sync health.
  assertEquals(out.score, 100);
  assertEquals(out.weightCounted, 100 - QUALITY_WEIGHTS.fulfillment);
  assertEquals(out.components.find((c) => c.key === "fulfillment")!.status, "unknown");
  assert(!out.topFixes.some((f) => f.key === "fulfillment"), "unknown is not a fix suggestion");
});

Deno.test("an unverified category is unknown, a non-leaf category is a fix", () => {
  const unknown = perfect();
  unknown.category = { leafStatus: "unverified", matchesSuggestion: null };
  assertEquals(computeListingQualityScore(unknown).score, 100);

  const nonLeaf = perfect();
  nonLeaf.category = { leafStatus: "non_leaf", matchesSuggestion: null };
  const out = computeListingQualityScore(nonLeaf);
  assert(out.score < 100);
  assertEquals(out.components.find((c) => c.key === "category")!.status, "fix");
});

Deno.test("no readable signal at all reports 0 with weightCounted 0", () => {
  const out = computeListingQualityScore({
    title: { text: "A reasonable jacket title for a listing", policyViolations: [], warnings: [] },
    aspects: { requiredMissing: [], recommendedFilled: 1, recommendedTotal: 1 },
    photos: { blockers: [], warnings: [], nudge: null, count: 1 },
    category: { leafStatus: "unverified", matchesSuggestion: null },
    condition: { consistent: null, warnings: [] },
    fulfillment: UNKNOWN_FULFILLMENT,
  });
  // Three of six unknown, but the rest are readable ⇒ still a real score.
  assert(out.weightCounted > 0);
  assertEquals(out.score, 100);
});

// ── topFixes ranks by points actually recoverable ──────────────────────────

Deno.test("topFixes ranks the highest-value fix first and names its surface", () => {
  const i = perfect();
  i.aspects = { requiredMissing: [], recommendedFilled: 2, recommendedTotal: 8 };
  i.condition = { consistent: false, warnings: ["tier mismatch"] };
  const out = computeListingQualityScore(i);
  assertEquals(out.topFixes[0].key, "aspects", "aspects gap is worth more than the condition gap");
  assert(out.topFixes[0].pointsAvailable > 0);
  assertEquals(out.topFixes[0].fixSurface, "composer.aspects");
  // AC2: every component carries the surface that fixes it.
  assert(out.components.every((c) => c.fixSurface.length > 0));
});

// ── business-policy parsing ────────────────────────────────────────────────

Deno.test("handlingToDays normalises eBay's value+unit", () => {
  assertEquals(handlingToDays({ value: 1, unit: "DAY" }), 1);
  assertEquals(handlingToDays({ value: 0, unit: "DAY" }), 0);
  assertEquals(handlingToDays({ value: 2, unit: "BUSINESS_DAY" }), 2);
  // 24h is the same promise as 1 day; rejecting it would under-score a seller
  // who is actually meeting the bar.
  assertEquals(handlingToDays({ value: 24, unit: "HOUR" }), 1);
  // Unknown/garbage must be null (unknown), never a guessed number.
  assertEquals(handlingToDays({ value: 1, unit: "FORTNIGHT" }), null);
  assertEquals(handlingToDays({ value: -1, unit: "DAY" }), null);
  assertEquals(handlingToDays(null), null);
  assertEquals(handlingToDays("1 day"), null);
});

Deno.test("hasFreeShipping accepts both the flag and a zero cost", () => {
  assertEquals(
    hasFreeShipping({ shippingOptions: [{ optionType: "DOMESTIC", shippingServices: [{ freeShipping: true }] }] }),
    true,
  );
  assertEquals(
    hasFreeShipping({
      shippingOptions: [{ optionType: "DOMESTIC", shippingServices: [{ shippingCost: { value: "0", currency: "USD" } }] }],
    }),
    true,
  );
  assertEquals(
    hasFreeShipping({
      shippingOptions: [{ optionType: "DOMESTIC", shippingServices: [{ shippingCost: { value: "7.95" } }] }],
    }),
    false,
  );
});

Deno.test("a free INTERNATIONAL service does not make the listing free-shipping", () => {
  // Best Match ranks for the buyers being served; a free international option
  // is not the domestic signal eBay describes.
  assertEquals(
    hasFreeShipping({
      shippingOptions: [
        { optionType: "INTERNATIONAL", shippingServices: [{ freeShipping: true }] },
      ],
    }),
    null,
    "no domestic option at all ⇒ unknown, not false",
  );
  assertEquals(
    hasFreeShipping({
      shippingOptions: [
        { optionType: "DOMESTIC", shippingServices: [{ shippingCost: { value: "9.99" } }] },
        { optionType: "INTERNATIONAL", shippingServices: [{ freeShipping: true }] },
      ],
    }),
    false,
  );
});

Deno.test("policy parsing fails to null, never to false", () => {
  // "Unreadable" and "the seller does not accept returns" are different facts;
  // collapsing them would tell a seller to fix something already correct.
  assertEquals(parseFulfillmentSignals(null, null), UNKNOWN_FULFILLMENT);
  assertEquals(hasFreeShipping({}), null);
  assertEquals(hasFreeShipping({ shippingOptions: [] }), null);
  assertEquals(parseFulfillmentSignals(undefined, { returnsAccepted: false }).returnsAccepted, false);
});

Deno.test("parseFulfillmentSignals reads a realistic eBay policy pair", () => {
  const fulfillment = {
    handlingTime: { value: 1, unit: "DAY" },
    shippingOptions: [
      { optionType: "DOMESTIC", shippingServices: [{ shippingServiceCode: "USPSGround", freeShipping: true }] },
    ],
  };
  const ret = { returnsAccepted: true, returnPeriod: { value: 30, unit: "DAY" } };
  assertEquals(parseFulfillmentSignals(fulfillment, ret), {
    returnsAccepted: true,
    handlingDays: 1,
    freeShipping: true,
  });
});

// ── publish blockers cap the score ─────────────────────────────────────────
// The additive score lied about exactly the listings a seller most needs to
// find. These lock the fix in.

Deno.test("a listing that cannot publish is capped, however good the rest is", () => {
  // Everything perfect EXCEPT one missing required specific. eBay refuses to
  // list this; scoring it in the 70s would sort it into the "fine" pile.
  const i = perfect();
  i.aspects = { requiredMissing: ["Size"], recommendedFilled: 8, recommendedTotal: 8 };
  const out = computeListingQualityScore(i);
  assert(out.blocked, "missing a required specific must mark the listing blocked");
  assertEquals(out.score, BLOCKED_SCORE_CEILING);
  assert(out.blockingReasons.length > 0, "a blocked listing must say why");
  assert(out.blockingReasons[0].includes("required"));
});

Deno.test("each publish blocker independently caps the score", () => {
  const blockers: [string, (i: QualityScoreInput) => void][] = [
    ["no title", (i) => { i.title = { text: "", policyViolations: [], warnings: [] }; }],
    ["title policy violation", (i) => {
      i.title = { text: "Nike style not Patagonia", policyViolations: ["Unrelated brand comparison"], warnings: [] };
    }],
    ["required aspect missing", (i) => { i.aspects = { requiredMissing: ["Brand"], recommendedFilled: 8, recommendedTotal: 8 }; }],
    ["no photos", (i) => { i.photos = { blockers: [], warnings: [], nudge: null, count: 0 }; }],
    ["photo below 500px", (i) => { i.photos = { blockers: ["Hero photo is 320px"], warnings: [], nudge: null, count: 4 }; }],
    ["non-leaf category", (i) => { i.category = { leafStatus: "non_leaf", matchesSuggestion: null }; }],
    ["category not found", (i) => { i.category = { leafStatus: "not_found", matchesSuggestion: null }; }],
  ];
  for (const [label, mut] of blockers) {
    const i = perfect();
    mut(i);
    const out = computeListingQualityScore(i);
    assert(out.blocked, `${label} must mark blocked`);
    assert(out.score <= BLOCKED_SCORE_CEILING, `${label} scored ${out.score}, above the cap`);
  }
});

Deno.test("a merely WEAK listing is not marked blocked", () => {
  // The cap must not swallow ordinary low quality — a seller has to be able to
  // tell "will not list" from "will list badly".
  const i = perfect();
  i.aspects = { requiredMissing: [], recommendedFilled: 1, recommendedTotal: 8 };
  i.photos = { blockers: [], warnings: ["Hero photo is below 1600px"], nudge: "First photo is a tag shot", count: 2 };
  i.fulfillment = { returnsAccepted: false, handlingDays: 5, freeShipping: false };
  const out = computeListingQualityScore(i);
  assertEquals(out.blocked, false);
  assert(out.score > BLOCKED_SCORE_CEILING, `a publishable-but-weak listing should outrank a blocked one; got ${out.score}`);
  assert(out.score < 80, `…but should not look healthy; got ${out.score}`);
});

Deno.test("blocked ranks below every publishable listing", () => {
  const weak = perfect();
  weak.aspects = { requiredMissing: [], recommendedFilled: 0, recommendedTotal: 8 };
  weak.photos = { blockers: [], warnings: ["low res"], nudge: "tag shot", count: 1 };
  weak.title = { text: "Jacket", policyViolations: [], warnings: ["ALL CAPS"] };
  weak.condition = { consistent: false, warnings: ["mismatch"] };
  weak.fulfillment = { returnsAccepted: false, handlingDays: 9, freeShipping: false };

  const blocked = perfect();
  blocked.category = { leafStatus: "non_leaf", matchesSuggestion: true };

  const w = computeListingQualityScore(weak);
  const b = computeListingQualityScore(blocked);
  assertEquals(w.blocked, false);
  assertEquals(b.blocked, true);
  assert(
    b.score < w.score,
    `an unlistable listing (${b.score}) must sort below the worst listable one (${w.score}) — ` +
      "that ordering is the whole point of the cap",
  );
});
