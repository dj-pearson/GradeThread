// US-1812: buyer grade confirm/dispute engine — the pure decision math
// (dispute severity, guarantee eligibility, seller integrity score). No DB.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  deriveDisputeSeverity,
  decideGuaranteeEligible,
  computeSellerIntegrityScore,
  MIN_INTEGRITY_SAMPLE,
  MIN_CONFIRMED_FOR_TIER,
  sellerIntegrityTier,
  countableSellerOutcomes,
  withDisputeResolution,
} = await import("../lib/buyer-grade-confirmation.ts");

const NOW = Date.UTC(2026, 6, 9);
const inDays = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

// ─── deriveDisputeSeverity ──────────────────────────────────────────────────

Deno.test("severity: over-grade at/above threshold is material", () => {
  assertEquals(deriveDisputeSeverity(1.0, 1.0), "material");
  assertEquals(deriveDisputeSeverity(2.5, 1.0), "material");
});

Deno.test("severity: below threshold is cosmetic", () => {
  assertEquals(deriveDisputeSeverity(0.5, 1.0), "cosmetic");
  assertEquals(deriveDisputeSeverity(0, 1.0), "cosmetic");
});

Deno.test("severity: a zero/negative threshold never yields material", () => {
  // A misconfigured threshold must not silently make every nitpick material.
  assertEquals(deriveDisputeSeverity(5, 0), "cosmetic");
});

// ─── decideGuaranteeEligible ────────────────────────────────────────────────

const COVERED = { eligible: true, coveredUntil: inDays(10), gradeDeltaThreshold: 1.0 };

Deno.test("guarantee: material dispute, eligible + in-window + over threshold → eligible", () => {
  assertEquals(
    decideGuaranteeEligible({
      matchStatus: "disputed",
      severity: "material",
      overallDelta: 1.5,
      coverage: COVERED,
      nowMs: NOW,
    }),
    true,
  );
});

Deno.test("guarantee: a confirmation is never eligible", () => {
  assertEquals(
    decideGuaranteeEligible({
      matchStatus: "confirmed",
      severity: "cosmetic",
      overallDelta: 0,
      coverage: COVERED,
      nowMs: NOW,
    }),
    false,
  );
});

Deno.test("guarantee: a cosmetic dispute is never eligible", () => {
  assertEquals(
    decideGuaranteeEligible({
      matchStatus: "disputed",
      severity: "cosmetic",
      overallDelta: 0.5,
      coverage: COVERED,
      nowMs: NOW,
    }),
    false,
  );
});

Deno.test("guarantee: no coverage / ineligible coverage → not eligible", () => {
  const base = { matchStatus: "disputed" as const, severity: "material" as const, overallDelta: 2, nowMs: NOW };
  assertEquals(decideGuaranteeEligible({ ...base, coverage: null }), false);
  assertEquals(
    decideGuaranteeEligible({ ...base, coverage: { ...COVERED, eligible: false } }),
    false,
  );
});

Deno.test("guarantee: outside the window → not eligible", () => {
  assertEquals(
    decideGuaranteeEligible({
      matchStatus: "disputed",
      severity: "material",
      overallDelta: 2,
      coverage: { ...COVERED, coveredUntil: inDays(-1) },
      nowMs: NOW,
    }),
    false,
  );
});

Deno.test("guarantee: delta below the coverage threshold → not eligible", () => {
  assertEquals(
    decideGuaranteeEligible({
      matchStatus: "disputed",
      severity: "material",
      overallDelta: 0.5,
      coverage: { ...COVERED, gradeDeltaThreshold: 2.0 },
      nowMs: NOW,
    }),
    false,
  );
});

// ─── computeSellerIntegrityScore ────────────────────────────────────────────

Deno.test("integrity: a new seller (no outcomes) scores 100", () => {
  assertEquals(
    computeSellerIntegrityScore({
      confirmed_count: 0,
      disputed_count: 0,
      material_dispute_count: 0,
      total_outcomes: 0,
    }),
    100,
  );
});

Deno.test("integrity: all confirmations score 100", () => {
  assertEquals(
    computeSellerIntegrityScore({
      confirmed_count: 20,
      disputed_count: 0,
      material_dispute_count: 0,
      total_outcomes: 20,
    }),
    100,
  );
});

Deno.test("integrity: one material dispute is smoothed, not zero", () => {
  // weightedBad = 1 + 1 = 2; weightedTotal = 1 + 1 = 2; effective = max(2,5)=5
  // score = round(100 * (1 - 2/5)) = 60
  assertEquals(
    computeSellerIntegrityScore({
      confirmed_count: 0,
      disputed_count: 1,
      material_dispute_count: 1,
      total_outcomes: 1,
    }),
    60,
  );
});

Deno.test("integrity: a material dispute weighs double a cosmetic one", () => {
  const cosmetic = computeSellerIntegrityScore({
    confirmed_count: 9,
    disputed_count: 1,
    material_dispute_count: 0,
    total_outcomes: 10,
  });
  const material = computeSellerIntegrityScore({
    confirmed_count: 9,
    disputed_count: 1,
    material_dispute_count: 1,
    total_outcomes: 10,
  });
  // cosmetic: bad=1 total=10 → 90 ; material: bad=2 total=11 → round(100*(1-2/11))=82
  assertEquals(cosmetic, 90);
  assertEquals(material, 82);
});

Deno.test("integrity: score never drops below 0", () => {
  const score = computeSellerIntegrityScore({
    confirmed_count: 0,
    disputed_count: 50,
    material_dispute_count: 50,
    total_outcomes: 50,
  });
  assertEquals(score, 0);
});

Deno.test("integrity: MIN_INTEGRITY_SAMPLE is the smoothing floor", () => {
  assertEquals(MIN_INTEGRITY_SAMPLE, 5);
});

// ─── sellerIntegrityTier (US-1912) ──────────────────────────────────────────

Deno.test("tier: below the confirmed-volume floor is non-displayable 'building'", () => {
  const r = sellerIntegrityTier({ integrityScore: 100, confirmedCount: 3 });
  assertEquals(r.tier, "building");
  assertEquals(r.displayable, false);
  assertEquals(r.nextTier, "verified");
  assertEquals(r.nextTierGaps, [`${MIN_CONFIRMED_FOR_TIER - 3} more confirmed outcomes`]);
});

Deno.test("tier: a low score above the floor is still Verified (never a bad public score)", () => {
  const r = sellerIntegrityTier({ integrityScore: 40, confirmedCount: 12 });
  assertEquals(r.tier, "verified");
  assertEquals(r.displayable, true);
});

Deno.test("tier: reliable at score ≥90 with ≥10 confirmed", () => {
  const r = sellerIntegrityTier({ integrityScore: 92, confirmedCount: 15 });
  assertEquals(r.tier, "reliable");
  assertEquals(r.nextTier, "trusted");
});

Deno.test("tier: trusted requires score+volume+coverage+tenure", () => {
  const base = { integrityScore: 96, confirmedCount: 30, avgCoveragePct: 80, tenureDays: 120, gradedVolume: 60 };
  assertEquals(sellerIntegrityTier(base).tier, "trusted");
  // Missing coverage floor drops it back to reliable.
  assertEquals(sellerIntegrityTier({ ...base, avgCoveragePct: 60 }).tier, "reliable");
  // Too little tenure also drops it.
  assertEquals(sellerIntegrityTier({ ...base, tenureDays: 30 }).tier, "reliable");
});

Deno.test("tier: elite is the top, gated hardest", () => {
  const r = sellerIntegrityTier({ integrityScore: 99, confirmedCount: 60, avgCoveragePct: 95, tenureDays: 200, gradedVolume: 150 });
  assertEquals(r.tier, "elite");
  assertEquals(r.nextTier, null);
  assertEquals(r.nextTierGaps, []);
});

Deno.test("tier: unknown coverage/tenure never blocks (not gated on null)", () => {
  // Score+volume qualify for trusted; coverage/tenure unknown → still trusted.
  const r = sellerIntegrityTier({ integrityScore: 96, confirmedCount: 30, gradedVolume: 60 });
  assertEquals(r.tier, "trusted");
});

Deno.test("tier: gaps explain the path to the next tier", () => {
  const r = sellerIntegrityTier({ integrityScore: 92, confirmedCount: 15, avgCoveragePct: 60, tenureDays: 30, gradedVolume: 20 });
  assertEquals(r.tier, "reliable");
  // needs score≥95, +10 confirmed, coverage≥75, 90d tenure, +20 graded
  assertEquals(r.nextTierGaps.includes("integrity ≥ 95"), true);
  assertEquals(r.nextTierGaps.some((g) => g.includes("confirmed outcomes")), true);
  assertEquals(r.nextTierGaps.includes("avg photo coverage ≥ 75%"), true);
});

// ─── US-1912 AC2: anti-gaming outcome filter ────────────────────────────────
const SELLER = "seller-1";
const row = (
  buyer: string | null,
  match: string,
  severity: string | null = null,
  resolved = true,
) => ({ buyer_user_id: buyer, match_status: match, dispute_severity: severity, dispute_resolved: resolved });

Deno.test("countableSellerOutcomes: excludes self-purchase confirmations", () => {
  const counts = countableSellerOutcomes(
    [row("buyer-a", "confirmed"), row(SELLER, "confirmed"), row("buyer-b", "confirmed")],
    { sellerUserId: SELLER },
  );
  // The seller's own confirmation is dropped → 2, not 3.
  assertEquals(counts.confirmed_count, 2);
  assertEquals(counts.total_outcomes, 2);
});

Deno.test("countableSellerOutcomes: excludes linked-account confirmations", () => {
  const counts = countableSellerOutcomes(
    [row("buyer-a", "confirmed"), row("alt-account", "confirmed")],
    { sellerUserId: SELLER, linkedUserIds: new Set(["alt-account"]) },
  );
  assertEquals(counts.confirmed_count, 1);
});

Deno.test("countableSellerOutcomes: an UNRESOLVED dispute does not count (not bad, not total)", () => {
  const counts = countableSellerOutcomes(
    [row("buyer-a", "confirmed"), row("buyer-b", "disputed", "material", false)],
    { sellerUserId: SELLER },
  );
  assertEquals(counts.confirmed_count, 1);
  assertEquals(counts.disputed_count, 0); // unresolved → excluded entirely
  assertEquals(counts.material_dispute_count, 0);
  assertEquals(counts.total_outcomes, 1);
});

Deno.test("countableSellerOutcomes: a RESOLVED material dispute counts once + flags material", () => {
  const counts = countableSellerOutcomes(
    [row("buyer-a", "confirmed"), row("buyer-b", "disputed", "material", true)],
    { sellerUserId: SELLER },
  );
  assertEquals(counts.disputed_count, 1);
  assertEquals(counts.material_dispute_count, 1);
  assertEquals(counts.total_outcomes, 2);
});

Deno.test("countableSellerOutcomes: requireResolvedDispute:false counts disputes regardless", () => {
  const counts = countableSellerOutcomes(
    [row("buyer-b", "disputed", "cosmetic", false)],
    { sellerUserId: SELLER, requireResolvedDispute: false },
  );
  assertEquals(counts.disputed_count, 1);
  assertEquals(counts.material_dispute_count, 0);
});

Deno.test("countableSellerOutcomes: a self-purchase DISPUTE is also excluded (no self-sabotage/gaming)", () => {
  const counts = countableSellerOutcomes(
    [row(SELLER, "disputed", "material", true), row("buyer-a", "confirmed")],
    { sellerUserId: SELLER },
  );
  assertEquals(counts.disputed_count, 0);
  assertEquals(counts.confirmed_count, 1);
});

Deno.test("countableSellerOutcomes: null buyer_user_id is kept (can't attribute to self/linked)", () => {
  const counts = countableSellerOutcomes([row(null, "confirmed")], { sellerUserId: SELLER });
  assertEquals(counts.confirmed_count, 1);
});

// ── US-1912 AC2: an escalated dispute counts once an expert has ruled ───────
//
// The rule was previously approximated as `dispute_resolved = human_review_flagged
// !== true`, which is right at the moment a dispute is raised and wrong forever
// after. A flagged dispute is one an expert was ASKED to rule on, so that
// expression excluded it permanently — including after the expert ruled and
// agreed with the buyer.
//
// The consequence runs the wrong way for a trust score: escalating a dispute was
// what removed it from the seller's record, so a seller with repeated
// confirmed-material disputes kept a spotless integrity score. Benefit of the
// doubt was correct; making it permanent was not.
//
// human_reviews has no status column — a ROW EXISTING is the resolution
// (reviewed_at is NOT NULL DEFAULT now(), 00003). So the predicate is simply
// "does a review row exist for this outcome's grade report".

Deno.test("US-1912: an unreviewed escalated dispute is still pending", () => {
  const rows = withDisputeResolution(
    [{
      grade_report_id: "gr-1",
      buyer_user_id: "buyer",
      match_status: "disputed",
      dispute_severity: "material",
      human_review_flagged: true,
    }],
    new Set<string>(),
  );
  assertEquals(rows[0]!.dispute_resolved, false);
  // And it therefore does not dent the score yet.
  const counts = countableSellerOutcomes(rows, { sellerUserId: "seller" });
  assertEquals(counts.disputed_count, 0);
  assertEquals(counts.total_outcomes, 0);
});

Deno.test("US-1912: the SAME dispute counts once its review exists", () => {
  // The half the approximation could never reach. Same row, same flag — the
  // only thing that changed is that an expert ruled.
  const row = {
    grade_report_id: "gr-1",
    buyer_user_id: "buyer",
    match_status: "disputed",
    dispute_severity: "material",
    human_review_flagged: true,
  };
  const rows = withDisputeResolution([row], new Set(["gr-1"]));
  assertEquals(rows[0]!.dispute_resolved, true);
  const counts = countableSellerOutcomes(rows, { sellerUserId: "seller" });
  assertEquals(counts.disputed_count, 1);
  assertEquals(counts.material_dispute_count, 1);
});

Deno.test("US-1912: a never-escalated dispute counts immediately", () => {
  // Unchanged behaviour, pinned so the fix does not quietly start withholding
  // minor disputes that never needed review.
  const rows = withDisputeResolution(
    [{
      grade_report_id: "gr-2",
      buyer_user_id: "buyer",
      match_status: "disputed",
      dispute_severity: "cosmetic",
      human_review_flagged: false,
    }],
    new Set<string>(),
  );
  assertEquals(rows[0]!.dispute_resolved, true);
  assertEquals(
    countableSellerOutcomes(rows, { sellerUserId: "seller" }).disputed_count,
    1,
  );
});

Deno.test("US-1912: a review for a DIFFERENT report does not resolve this one", () => {
  // The join has to be per-report. Matching on "any review exists" would let
  // one resolved dispute clear every pending dispute the seller has.
  const rows = withDisputeResolution(
    [{
      grade_report_id: "gr-1",
      buyer_user_id: "buyer",
      match_status: "disputed",
      dispute_severity: "material",
      human_review_flagged: true,
    }],
    new Set(["gr-999"]),
  );
  assertEquals(rows[0]!.dispute_resolved, false);
});

Deno.test("US-1912: an escalated dispute with NO report id stays pending", () => {
  // Nothing to join on. Counting it would mean treating "we cannot tell" as
  // "an expert ruled against the seller", which is the one reading a
  // reputation score must never make.
  const rows = withDisputeResolution(
    [{
      grade_report_id: null,
      buyer_user_id: "buyer",
      match_status: "disputed",
      dispute_severity: "material",
      human_review_flagged: true,
    }],
    new Set(["gr-1"]),
  );
  assertEquals(rows[0]!.dispute_resolved, false);
});

Deno.test("US-1912: confirmations are untouched by the resolution rule", () => {
  // dispute_resolved is meaningless for a confirmation, and a mapper that
  // accidentally dropped or altered them would silently change every score.
  const rows = withDisputeResolution(
    [
      { grade_report_id: "gr-1", buyer_user_id: "b1", match_status: "confirmed", dispute_severity: null, human_review_flagged: false },
      { grade_report_id: "gr-2", buyer_user_id: "b2", match_status: "confirmed", dispute_severity: null, human_review_flagged: true },
    ],
    new Set<string>(),
  );
  assertEquals(rows.length, 2);
  const counts = countableSellerOutcomes(rows, { sellerUserId: "seller" });
  assertEquals(counts.confirmed_count, 2);
  assertEquals(counts.disputed_count, 0);
});

Deno.test("US-1912: the recompute reads the review table, it does not infer it", () => {
  // The approximation lived as one expression inside an async function nobody
  // could exercise, which is exactly why it survived. Pin that the join is
  // actually performed and that the old inference is gone.
  const src = Deno.readTextFileSync(
    new URL("../lib/buyer-grade-confirmation.ts", import.meta.url),
  );
  // Comments stripped: the explanation above the fix quotes the old expression
  // verbatim, so a raw scan would find the defect in its own post-mortem.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");

  assert(
    /\.from\("human_reviews"\)/.test(code),
    "the recompute no longer reads human_reviews, so an escalated dispute can " +
      "never count again",
  );
  assert(
    !/dispute_resolved: row\.human_review_flagged !== true/.test(code),
    "the old inference is back — escalating a dispute again excludes it forever",
  );
  // And it must fail toward the seller when that read errors.
  //
  // Asserted on the CONSTRUCT, not on the explanation. The first version of
  // this matched the phrase "still pending", which lives in the log message —
  // so deleting the reasoning left it green and the case was checking prose
  // about the behaviour rather than the behaviour. That is the same
  // satisfied-by-its-own-comment shape this file's guards exist to avoid.
  //
  // The property: the reviewed set is populated ONLY on the success branch, so
  // an errored read leaves it empty and every escalated dispute stays pending.
  const errBranch = code.indexOf("if (revErr)");
  const assign = code.indexOf("reviewedReportIds = new Set(");
  assert(errBranch > -1, "the human_reviews read no longer checks for an error");
  assert(assign > -1, "the reviewed-report set is no longer built");
  assert(
    assign > errBranch && /\} else \{[\s\S]{0,120}reviewedReportIds = new Set\(/.test(code),
    "the reviewed-report set is populated outside the success branch, so a " +
      "failed human_reviews read could start counting disputes nobody has " +
      "confirmed — denting seller scores on a database blip",
  );
});
