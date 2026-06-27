// US-1279/US-1280: coverage-gated guarantee remedy — scope evaluation + the
// idempotent grade-fee-back remedy. Pure logic + dependency-injected money side,
// so no DB/Stripe is needed.
import { assert, assertEquals } from "@std/assert";
import {
  evaluateClaimScope,
  issueGuaranteeRemedy,
  type RemedyContext,
  type RemedyDeps,
  type RemedyResult,
} from "../lib/guarantee-remedy.ts";

const TSHIRT_FULL = {
  garment_category: "tops",
  applicable_zones: ["front", "back", "collar_neckline", "cuffs", "hem"],
  covered_zones: ["front", "back", "collar_neckline", "cuffs", "hem"],
  coverage_pct: 100,
};
const TSHIRT_PARTIAL = {
  garment_category: "tops",
  applicable_zones: ["front", "back", "collar_neckline", "cuffs", "hem"],
  covered_zones: ["front", "back"], // cuffs/collar/hem NOT documented
  coverage_pct: 40,
};

// ── evaluateClaimScope (shared by US-1279 AC2 + the remedy gate) ─────────────

Deno.test("scope: full coverage → any claim is in-scope", () => {
  const s = evaluateClaimScope(
    [{ defect: "stain", location: "left cuff" }],
    TSHIRT_FULL,
    "tops",
  );
  assert(s.inScope);
  assert(s.fullyCovered);
  assertEquals(s.documentedZones, ["cuffs"]);
});

Deno.test("scope: partial coverage, claim in a DOCUMENTED zone → in-scope", () => {
  const s = evaluateClaimScope(
    [{ defect: "hole", location: "front chest" }],
    TSHIRT_PARTIAL,
    "tops",
  );
  assert(s.inScope);
  assertEquals(s.documentedZones, ["front"]);
  assertEquals(s.undocumentedZones, []);
});

Deno.test("scope: partial coverage, claim in an UNDOCUMENTED zone → out of scope", () => {
  const s = evaluateClaimScope(
    [{ defect: "fray", location: "right cuff" }],
    TSHIRT_PARTIAL,
    "tops",
  );
  assert(!s.inScope);
  assertEquals(s.documentedZones, []);
  assertEquals(s.undocumentedZones, ["cuffs"]);
});

Deno.test("scope: mixed claim with at least one documented zone → in-scope", () => {
  const s = evaluateClaimScope(
    [{ location: "cuff" }, { location: "front" }],
    TSHIRT_PARTIAL,
    "tops",
  );
  assert(s.inScope);
  assertEquals(s.documentedZones, ["front"]);
  assertEquals(s.undocumentedZones, ["cuffs"]);
});

Deno.test("scope: no coverage record → out of scope (can't prove the zone was shown)", () => {
  const s = evaluateClaimScope([{ location: "front" }], null, "tops");
  assert(!s.hasCoverage);
  assert(!s.inScope);
});

Deno.test("scope: unrecognizable location under partial coverage → out of scope", () => {
  const s = evaluateClaimScope(
    [{ location: "somewhere vague" }],
    TSHIRT_PARTIAL,
    "tops",
  );
  assert(!s.inScope);
  assertEquals(s.documentedZones, []);
});

// ── issueGuaranteeRemedy (US-1280) ──────────────────────────────────────────

interface Recorder {
  claimed: number;
  stripeRefunds: Array<{ pi: string; claim: string }>;
  grants: Array<{ user: string; credits: number; notes: string }>;
  recorded: RemedyResult[];
}

function fakeDeps(opts: { alreadyIssued?: boolean } = {}): {
  deps: RemedyDeps;
  rec: Recorder;
} {
  const rec: Recorder = { claimed: 0, stripeRefunds: [], grants: [], recorded: [] };
  const deps: RemedyDeps = {
    claimRemedy: () => {
      rec.claimed += 1;
      return Promise.resolve(!opts.alreadyIssued);
    },
    refundStripe: (pi, claim) => {
      rec.stripeRefunds.push({ pi, claim });
      return Promise.resolve({ refundId: `re_${claim}`, cents: 299 });
    },
    grantCredits: (user, credits, notes) => {
      rec.grants.push({ user, credits, notes });
      return Promise.resolve();
    },
    recordResult: (_claimId, result) => {
      rec.recorded.push(result);
      return Promise.resolve();
    },
  };
  return { deps, rec };
}

function ctx(over: Partial<RemedyContext> = {}): RemedyContext {
  return {
    claimId: "claim-1",
    gradeReportId: "gr-1",
    submissionId: "sub-1",
    sellerUserId: "seller-1",
    scope: evaluateClaimScope([{ location: "front" }], TSHIRT_FULL, "tops"),
    payment: {
      paymentStatus: "paid_stripe",
      stripePaymentIntentId: "pi_123",
      serviceTier: "standard",
    },
    ...over,
  };
}

Deno.test("remedy: approved + covered + paid_stripe → Stripe refund + free re-grade, once", async () => {
  const { deps, rec } = fakeDeps();
  const r = await issueGuaranteeRemedy(ctx(), deps);
  assert(r.issued);
  assertEquals(r.feeRefundMethod, "stripe");
  assertEquals(r.feeRefundCents, 299);
  assertEquals(r.stripeRefundId, "re_claim-1");
  assertEquals(r.regradeCredits, 1);
  assertEquals(rec.stripeRefunds.length, 1);
  // Exactly one credit grant: the free re-grade (the fee came back via Stripe).
  assertEquals(rec.grants.length, 1);
  assertEquals(rec.grants[0]!.credits, 1);
  assertEquals(rec.recorded.length, 1);
});

Deno.test("remedy: approved + covered + paid by credits → credit-back tier cost + re-grade", async () => {
  const { deps, rec } = fakeDeps();
  const r = await issueGuaranteeRemedy(
    ctx({ payment: { paymentStatus: "credits", stripePaymentIntentId: null, serviceTier: "premium" } }),
    deps,
  );
  assert(r.issued);
  assertEquals(r.feeRefundMethod, "credit");
  assertEquals(r.feeRefundCredits, 3); // premium = 3 credits
  assertEquals(r.stripeRefundId, null);
  assertEquals(rec.stripeRefunds.length, 0);
  // Two grants: the 3-credit fee-back + the 1-credit re-grade.
  assertEquals(rec.grants.map((g) => g.credits).sort(), [1, 3]);
});

Deno.test("remedy: approved + covered + included → no fee refund, still a free re-grade", async () => {
  const { deps, rec } = fakeDeps();
  const r = await issueGuaranteeRemedy(
    ctx({ payment: { paymentStatus: "included", stripePaymentIntentId: null, serviceTier: "standard" } }),
    deps,
  );
  assert(r.issued);
  assertEquals(r.feeRefundMethod, "none");
  assertEquals(r.feeRefundCents, 0);
  assertEquals(r.feeRefundCredits, 0);
  assertEquals(r.regradeCredits, 1);
  assertEquals(rec.grants.length, 1);
});

Deno.test("remedy: approved but OUT OF SCOPE → no remedy, no money moved", async () => {
  const { deps, rec } = fakeDeps();
  const outOfScope = evaluateClaimScope([{ location: "cuff" }], TSHIRT_PARTIAL, "tops");
  const r = await issueGuaranteeRemedy(ctx({ scope: outOfScope }), deps);
  assert(!r.issued);
  assertEquals(r.reason, "out_of_scope");
  assertEquals(rec.claimed, 0); // never even claimed the ledger
  assertEquals(rec.stripeRefunds.length, 0);
  assertEquals(rec.grants.length, 0);
});

Deno.test("remedy: reprocessing the same claim is idempotent (no double refund)", async () => {
  const { deps, rec } = fakeDeps({ alreadyIssued: true });
  const r = await issueGuaranteeRemedy(ctx(), deps);
  assert(!r.issued);
  assertEquals(r.reason, "already_issued");
  assertEquals(rec.claimed, 1); // gate consulted...
  assertEquals(rec.stripeRefunds.length, 0); // ...but no money moved
  assertEquals(rec.grants.length, 0);
  assertEquals(rec.recorded.length, 0);
});
