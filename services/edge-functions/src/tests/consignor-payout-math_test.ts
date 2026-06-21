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
