// US-1821: buyer purchase-guarantee remedy decision (pure). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  decideBuyerGuaranteeRemedy,
  normalizeBuyerGuaranteeRemedyConfig,
  DEFAULT_BUYER_GUARANTEE_REMEDY_CONFIG,
} = await import("../lib/buyer-guarantee-claim.ts");

const NOW = Date.UTC(2026, 6, 10);
const inDays = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const CFG = DEFAULT_BUYER_GUARANTEE_REMEDY_CONFIG; // pct 50, flat 2500, /credit 500, auto_max 10000
const COVERAGE = { eligible: true, coveredUntil: inDays(10), payoutCapCents: 20000 };

const materialEvidence = {
  matchStatus: "disputed" as const,
  disputeSeverity: "material" as const,
  guaranteeEligible: true,
  overallDelta: 2,
  purchasePriceCents: 6000, // $60 → 50% = $30 = 3000c → 6 credits
};

// ── decision ────────────────────────────────────────────────────────────────

Deno.test("claim: material + eligible + in-window auto-approves within cap", () => {
  const r = decideBuyerGuaranteeRemedy(materialEvidence, COVERAGE, CFG, NOW);
  assertEquals(r.decision, "auto_approved");
  assertEquals(r.remedyCents, 3000); // 50% of $60
  assertEquals(r.remedyCredits, 6); // 3000 / 500
});

Deno.test("claim: remedy is capped by the coverage payout cap", () => {
  const r = decideBuyerGuaranteeRemedy(
    { ...materialEvidence, purchasePriceCents: 100000 }, // 50% = $500
    { ...COVERAGE, payoutCapCents: 8000 }, // cap $80
    CFG,
    NOW,
  );
  // capped to 8000, but 8000 > auto_max 10000? no, 8000 ≤ 10000 → auto
  assertEquals(r.remedyCents, 8000);
  assertEquals(r.decision, "auto_approved");
});

Deno.test("claim: a remedy over the auto-max routes to manual review", () => {
  const r = decideBuyerGuaranteeRemedy(
    { ...materialEvidence, purchasePriceCents: 40000 }, // 50% = $200 = 20000c
    { ...COVERAGE, payoutCapCents: 20000 },
    CFG,
    NOW,
  );
  assertEquals(r.remedyCents, 20000);
  assertEquals(r.decision, "manual_review");
});

Deno.test("claim: no recorded price falls back to the flat remedy", () => {
  const r = decideBuyerGuaranteeRemedy(
    { ...materialEvidence, purchasePriceCents: null },
    COVERAGE,
    CFG,
    NOW,
  );
  assertEquals(r.remedyCents, 2500);
  assertEquals(r.remedyCredits, 5);
  assertEquals(r.decision, "auto_approved");
});

Deno.test("claim: a cosmetic dispute is rejected", () => {
  const r = decideBuyerGuaranteeRemedy(
    { ...materialEvidence, disputeSeverity: "cosmetic" },
    COVERAGE,
    CFG,
    NOW,
  );
  assertEquals(r.decision, "rejected");
  assertEquals(r.reason, "not_a_material_mismatch");
});

Deno.test("claim: not guarantee_eligible is rejected", () => {
  const r = decideBuyerGuaranteeRemedy(
    { ...materialEvidence, guaranteeEligible: false },
    COVERAGE,
    CFG,
    NOW,
  );
  assertEquals(r.decision, "rejected");
  assertEquals(r.reason, "not_guarantee_eligible");
});

Deno.test("claim: lapsed coverage window is rejected", () => {
  const r = decideBuyerGuaranteeRemedy(
    materialEvidence,
    { ...COVERAGE, coveredUntil: inDays(-1) },
    CFG,
    NOW,
  );
  assertEquals(r.decision, "rejected");
  assertEquals(r.reason, "coverage_window_lapsed");
});

Deno.test("claim: no / ineligible coverage is rejected", () => {
  assertEquals(decideBuyerGuaranteeRemedy(materialEvidence, null, CFG, NOW).reason, "coverage_not_eligible");
  assertEquals(
    decideBuyerGuaranteeRemedy(materialEvidence, { ...COVERAGE, eligible: false }, CFG, NOW).decision,
    "rejected",
  );
});

Deno.test("claim: auto_approve=false forces manual review even within cap", () => {
  const r = decideBuyerGuaranteeRemedy(materialEvidence, COVERAGE, { ...CFG, auto_approve: false }, NOW);
  assertEquals(r.decision, "manual_review");
});

// ── config normalize ────────────────────────────────────────────────────────

Deno.test("config: garbage → defaults; cents_per_credit never 0", () => {
  assertEquals(normalizeBuyerGuaranteeRemedyConfig(undefined), DEFAULT_BUYER_GUARANTEE_REMEDY_CONFIG);
  assertEquals(normalizeBuyerGuaranteeRemedyConfig({ cents_per_credit: 0 }).cents_per_credit, 1);
  assertEquals(normalizeBuyerGuaranteeRemedyConfig({ remedy_pct: 999 }).remedy_pct, 100);
});
