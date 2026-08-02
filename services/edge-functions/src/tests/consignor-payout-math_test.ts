// US-1112: consignor auto-payout pure math + decision logic. No env/DB needed —
// consignor-payout-math.ts is dependency-free by design.
import { assertEquals } from "@std/assert";
import {
  computeConsignorShare,
  parseAutoPayoutMode,
  planAutoPayout,
  roundCents,
} from "../lib/consignor-payout-math.ts";

Deno.test("computeConsignorShare: net = price − fees, share = net × split", () => {
  const { netProceeds, share, netSource } = computeConsignorShare({
    salePrice: 100,
    platformFees: 10,
    paymentProcessingFees: 5,
    splitPct: 60,
  });
  assertEquals(netProceeds, 85);
  assertEquals(share, 51); // 85 × 0.60
  assertEquals(netSource, "estimate");
});

Deno.test("computeConsignorShare: reconciled payout overrides the estimate (US-1123)", () => {
  // The estimate would be 100 − 10 − 5 = 85, but the marketplace actually
  // deposited 80 — pay the consignor on the real number.
  const { netProceeds, share, netSource } = computeConsignorShare({
    salePrice: 100,
    platformFees: 10,
    paymentProcessingFees: 5,
    splitPct: 60,
    reconciledNet: 80,
  });
  assertEquals(netProceeds, 80);
  assertEquals(share, 48); // 80 × 0.60
  assertEquals(netSource, "reconciled");
});

Deno.test("computeConsignorShare: a null/undefined reconciledNet falls back to the estimate", () => {
  for (const reconciledNet of [null, undefined]) {
    const r = computeConsignorShare({
      salePrice: 100,
      platformFees: 10,
      paymentProcessingFees: 5,
      splitPct: 60,
      reconciledNet,
    });
    assertEquals(r.netProceeds, 85);
    assertEquals(r.netSource, "estimate");
  }
});

Deno.test("computeConsignorShare: a reconciled $0 payout pays nothing (real number wins)", () => {
  const { netProceeds, share, netSource } = computeConsignorShare({
    salePrice: 100,
    platformFees: 0,
    paymentProcessingFees: 0,
    splitPct: 50,
    reconciledNet: 0,
  });
  assertEquals(netProceeds, 0);
  assertEquals(share, 0);
  assertEquals(netSource, "reconciled");
});

Deno.test("computeConsignorShare: clamps a fee-heavy sale to a $0 payout", () => {
  const { netProceeds, share } = computeConsignorShare({
    salePrice: 10,
    platformFees: 8,
    paymentProcessingFees: 5,
    splitPct: 50,
  });
  assertEquals(netProceeds, 0);
  assertEquals(share, 0);
});

Deno.test("computeConsignorShare: rounds the share to cents (no float drift)", () => {
  const { share } = computeConsignorShare({
    salePrice: 33.33,
    platformFees: 0,
    paymentProcessingFees: 0,
    splitPct: 33,
  });
  assertEquals(share, roundCents(33.33 * 0.33)); // 11.00
  assertEquals(share, 11);
});

Deno.test("computeConsignorShare: missing/garbage inputs degrade to 0", () => {
  const { netProceeds, share } = computeConsignorShare({
    salePrice: null,
    platformFees: undefined,
    paymentProcessingFees: null,
    splitPct: 50,
  });
  assertEquals(netProceeds, 0);
  assertEquals(share, 0);
});

Deno.test("computeConsignorShare: split is clamped to 0–100", () => {
  assertEquals(
    computeConsignorShare({ salePrice: 100, platformFees: 0, paymentProcessingFees: 0, splitPct: 150 }).share,
    100,
  );
  assertEquals(
    computeConsignorShare({ salePrice: 100, platformFees: 0, paymentProcessingFees: 0, splitPct: -10 }).share,
    0,
  );
});

Deno.test("parseAutoPayoutMode: only off/immediate pass through; else batched", () => {
  assertEquals(parseAutoPayoutMode("off"), "off");
  assertEquals(parseAutoPayoutMode("immediate"), "immediate");
  assertEquals(parseAutoPayoutMode("batched"), "batched");
  assertEquals(parseAutoPayoutMode("nonsense"), "batched");
  assertEquals(parseAutoPayoutMode(undefined), "batched");
});

Deno.test("planAutoPayout: no existing row + onboarded → create & transfer", () => {
  assertEquals(planAutoPayout({ existing: null, share: 51, onboarded: true }), {
    action: "create",
    settle: "transfer",
  });
});

Deno.test("planAutoPayout: no existing row + not onboarded → create & queue", () => {
  assertEquals(planAutoPayout({ existing: null, share: 51, onboarded: false }), {
    action: "create",
    settle: "queue",
  });
});

Deno.test("planAutoPayout: $0 share with no row → skip (never a $0 payout)", () => {
  assertEquals(planAutoPayout({ existing: null, share: 0, onboarded: true }), {
    action: "skip",
    reason: "zero_share",
  });
});

Deno.test("planAutoPayout: a settled row is never re-paid (idempotent)", () => {
  for (const status of ["paid", "processing", "canceled"]) {
    assertEquals(
      planAutoPayout({ existing: { id: "p1", status }, share: 51, onboarded: true }),
      { action: "skip", reason: "already_settled" },
    );
  }
});

Deno.test("planAutoPayout: pending row + now-onboarded → retry the transfer", () => {
  assertEquals(
    planAutoPayout({ existing: { id: "p1", status: "pending" }, share: 51, onboarded: true }),
    { action: "transfer", payoutId: "p1" },
  );
  // A failed row is retried the same way.
  assertEquals(
    planAutoPayout({ existing: { id: "p2", status: "failed" }, share: 51, onboarded: true }),
    { action: "transfer", payoutId: "p2" },
  );
});

Deno.test("planAutoPayout: pending row + still-not-onboarded → stays queued", () => {
  assertEquals(
    planAutoPayout({ existing: { id: "p1", status: "pending" }, share: 51, onboarded: false }),
    { action: "requeue", payoutId: "p1" },
  );
});

// ── US-2290 [P0]: a consignor paid by hand must not be paid again ───────────
//
// The two payout paths filed under different `source` values, and each looked
// only for its own. An operator who settled a consignor outside Stripe — cash,
// bank transfer — had it recorded as source='manual'; the sweep searched for
// source='auto', found nothing, and transferred the money a second time.
//
// The engine's own idempotency was never broken: a partial unique index on
// (sale_id) WHERE source='auto' guarantees at most one automatic payout. It
// just could not see the human. That is why the fix is a wider READ and one
// decision, not a second constraint.
//
// What this deliberately does NOT forbid is a second MANUAL payout for one
// sale. 00301's own comment establishes that as an intentional override — a
// partial payout, a top-up — and an operator adding one is a decision. What was
// never a decision is the engine adding one behind them.

Deno.test("US-2290: a settled manual payout blocks the engine", () => {
  const base = { existing: null, share: 5000, onboarded: true };
  for (const status of ["paid", "processing", "canceled"]) {
    assertEquals(
      planAutoPayout({ ...base, manual: [{ status }] }),
      { action: "skip", reason: "paid_manually" },
      `${status} must block`,
    );
  }
});

Deno.test("US-2290: a PENDING manual payout blocks too", () => {
  // The case this bug hit hardest. A pending manual row is the cash payout an
  // operator recorded so the consignor's balance would track — the money is
  // already gone, it just never went through Stripe.
  assertEquals(
    planAutoPayout({ existing: null, manual: [{ status: "pending" }], share: 5000, onboarded: true }),
    { action: "skip", reason: "paid_manually" },
  );
});

Deno.test("US-2290: a FAILED manual payout does not block", () => {
  // Nothing moved, so the engine picking the sale up is the recovery, not a
  // duplicate. Blocking here would strand a consignor unpaid.
  assertEquals(
    planAutoPayout({ existing: null, manual: [{ status: "failed" }], share: 5000, onboarded: true }),
    { action: "create", settle: "transfer" },
  );
});

Deno.test("US-2290: one failed and one paid manual row still blocks", () => {
  assertEquals(
    planAutoPayout({
      existing: null,
      manual: [{ status: "failed" }, { status: "paid" }],
      share: 5000,
      onboarded: true,
    }),
    { action: "skip", reason: "paid_manually" },
  );
});

Deno.test("US-2290: the manual check outranks the share and the auto row", () => {
  // A human has settled the sale, so nothing the engine computes is relevant —
  // including a $0 share or a half-finished auto row it would otherwise retry.
  assertEquals(
    planAutoPayout({ existing: null, manual: [{ status: "paid" }], share: 0, onboarded: true }),
    { action: "skip", reason: "paid_manually" },
  );
  assertEquals(
    planAutoPayout({
      existing: { id: "a1", status: "pending" },
      manual: [{ status: "paid" }],
      share: 5000,
      onboarded: true,
    }),
    { action: "skip", reason: "paid_manually" },
  );
});

Deno.test("US-2290: with no manual rows every prior decision is unchanged", () => {
  // The regression half. `manual` is optional, so an unmigrated caller behaves
  // exactly as before.
  const base = { existing: null, share: 5000, onboarded: true };
  assertEquals(planAutoPayout(base), { action: "create", settle: "transfer" });
  assertEquals(planAutoPayout({ ...base, manual: [] }), { action: "create", settle: "transfer" });
  assertEquals(planAutoPayout({ ...base, share: 0 }), { action: "skip", reason: "zero_share" });
  assertEquals(
    planAutoPayout({ ...base, existing: { id: "a1", status: "paid" } }),
    { action: "skip", reason: "already_settled" },
  );
  assertEquals(
    planAutoPayout({ ...base, existing: { id: "a1", status: "pending" } }),
    { action: "transfer", payoutId: "a1" },
  );
  assertEquals(
    planAutoPayout({ ...base, existing: { id: "a1", status: "failed" }, onboarded: false }),
    { action: "requeue", payoutId: "a1" },
  );
});

Deno.test("US-2290: the DECISION read covers both sources", () => {
  // A source assertion, because the defect was a query filter and has no
  // runtime symptom the engine can observe: it did the right thing with the
  // wrong rows.
  //
  // Narrow on purpose. Two other `.eq("source","auto")` filters in this file
  // are CORRECT and must stay — re-resolving the row that won a 23505 race on
  // the auto-only unique index, and the sweep's candidate discovery. Only the
  // read that feeds planAutoPayout had to widen.
  const src = Deno.readTextFileSync(
    new URL("../lib/consignor-payout.ts", import.meta.url),
  );
  assertEquals(src.includes("manual: manualPayouts"), true);
  assertEquals(src.includes('.select("id, status, source")'), true);
  // The specific regression: the decision read must not filter to auto. Anchored
  // on the surrounding lines so the two legitimate filters do not match.
  assertEquals(
    /\.select\("id, status, source"\)[\s\S]{0,120}?\.eq\("source", "auto"\)/.test(src),
    false,
  );
});

// US-2296: roundCents must be half-up at CURRENCY magnitudes, not just near 1.
// The previous implementation added Number.EPSILON, whose size is the gap at 1 —
// so it corrected the float error for small amounts and silently stopped
// correcting it for larger ones. These are the exact values that exposed it.
Deno.test("US-2296: roundCents is half-up at magnitudes where EPSILON was not", () => {
  // Small — the old implementation got these right too.
  assertEquals(roundCents(1.005), 1.01);
  assertEquals(roundCents(1.015), 1.02);
  assertEquals(roundCents(1.255), 1.26);
  // Larger — the old implementation returned 8.16 and 10.07.
  assertEquals(roundCents(8.165), 8.17);
  assertEquals(roundCents(10.075), 10.08);
  assertEquals(roundCents(1234.565), 1234.57);
});

Deno.test("US-2296: roundCents rounds the decimal a human reads, not the float", () => {
  // A value genuinely below the half stays down — this is not "always round up".
  assertEquals(roundCents(39.014999999999965), 39.01);
  assertEquals(roundCents(8.1649), 8.16);
  // Exact halves go up.
  assertEquals(roundCents(0.005), 0.01);
  assertEquals(roundCents(2.675), 2.68);
});

Deno.test("US-2296: roundCents survives the inputs that are not currency", () => {
  assertEquals(roundCents(Number.NaN), 0);
  assertEquals(roundCents(Number.POSITIVE_INFINITY), 0);
  assertEquals(roundCents(Number.NEGATIVE_INFINITY), 0);
  assertEquals(roundCents(0), 0);
  // Exponential-notation inputs would make the string trick parse as NaN, so
  // they take the fallback path rather than returning garbage.
  assertEquals(roundCents(1e-7), 0);
  assertEquals(roundCents(-1e-7), -0);
});

Deno.test("US-2296: property — result is always within half a cent of the input", () => {
  // The rounding may never move a payout by more than it is allowed to. A
  // deterministic sweep rather than random, so a failure reproduces exactly.
  let checked = 0;
  for (let cents = 0; cents <= 2_000_00; cents += 37) {
    for (const nudge of [0, 0.004, 0.005, 0.006, -0.004]) {
      const v = cents / 100 + nudge;
      const r = roundCents(v);
      if (Math.abs(r - v) > 0.005 + 1e-9) {
        throw new Error(`roundCents(${v}) = ${r} moved it more than half a cent`);
      }
      // And the result is always a whole number of cents.
      if (Math.abs(Math.round(r * 100) - r * 100) > 1e-6) {
        throw new Error(`roundCents(${v}) = ${r} is not a whole number of cents`);
      }
      checked++;
    }
  }
  assertEquals(checked > 25_000, true);
});
