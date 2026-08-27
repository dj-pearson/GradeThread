// US-2938: the return automation rules.
//
// The hard skip is the feature. A not-as-described return is the one return
// type where the grade report is an argument, and auto-approving one is the
// product silently conceding the dispute it exists to win. There is no
// configuration that turns that check off, and the first test here is the one
// that would notice if someone added one.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  MIN_RETURN_THRESHOLD_CENTS,
  decideReturnRule,
  dryRunReturnRule,
  normalizeThresholdCents,
} = await import("../lib/return-rules.ts");
import type { ReturnRuleConfig } from "../lib/return-rules.ts";

const WIDE: ReturnRuleConfig = {
  approveAtOrBelowCents: 10_000,
  refundWithoutReturnAtOrBelowCents: 2_000,
};

Deno.test("a SNAD return is ALWAYS skipped, whatever the thresholds say", () => {
  for (const reason of ["NOT_AS_DESCRIBED", "DEFECTIVE_ITEM", "ARRIVED_DAMAGED", "COUNTERFEIT"]) {
    const out = decideReturnRule(WIDE, {
      reason,
      orderTotalCents: 500, // well inside both thresholds
      state: "RETURN_REQUESTED",
    });
    assertEquals(out.decision, "skip", `${reason} must never auto-answer`);
    assert(out.reason.includes("person"));
  }
});

Deno.test("a plain change-of-mind return inside the approve band is approved", () => {
  const out = decideReturnRule(WIDE, {
    reason: "BUYER_CHANGED_MIND",
    orderTotalCents: 4_500,
    state: "RETURN_REQUESTED",
  });
  assertEquals(out.decision, "approve");
});

Deno.test("the keep-it band is checked BEFORE approve, because it is narrower", () => {
  const out = decideReturnRule(WIDE, {
    reason: "ORDERED_WRONG_SIZE",
    orderTotalCents: 1_500,
    state: "RETURN_REQUESTED",
  });
  assertEquals(out.decision, "refund_keep");
});

Deno.test("an unknown order total skips rather than defaulting to zero", () => {
  // Defaulting an unknown total to zero would put every return inside every
  // threshold and auto-approve the lot.
  const out = decideReturnRule(WIDE, {
    reason: "BUYER_CHANGED_MIND",
    orderTotalCents: null,
    state: "RETURN_REQUESTED",
  });
  assertEquals(out.decision, "skip");
  assert(out.reason.includes("unknown"));
});

Deno.test("a settled return is never re-answered", () => {
  for (const state of ["RETURN_CLOSED", "REFUNDED", "DECLINED", "RETURN_APPROVED"]) {
    assertEquals(
      decideReturnRule(WIDE, { reason: "BUYER_CHANGED_MIND", orderTotalCents: 500, state })
        .decision,
      "skip",
      state,
    );
  }
});

Deno.test("a blank threshold disables that half, it does not mean zero", () => {
  const approveOnly: ReturnRuleConfig = {
    approveAtOrBelowCents: 5_000,
    refundWithoutReturnAtOrBelowCents: null,
  };
  assertEquals(
    decideReturnRule(approveOnly, {
      reason: "BUYER_CHANGED_MIND",
      orderTotalCents: 300,
      state: "RETURN_REQUESTED",
    }).decision,
    "approve",
    "a cheap return still only approves; nothing is refunded outright",
  );

  const nothingSet: ReturnRuleConfig = {
    approveAtOrBelowCents: null,
    refundWithoutReturnAtOrBelowCents: null,
  };
  assertEquals(
    decideReturnRule(nothingSet, {
      reason: "BUYER_CHANGED_MIND",
      orderTotalCents: 100,
      state: "RETURN_REQUESTED",
    }).decision,
    "skip",
  );
});

Deno.test("above every threshold is a skip, not a decline", () => {
  // There is no auto-decline, and this asserts the absence. Declining puts the
  // seller on record refusing, and a wrongly-declined return escalates into a
  // case, which carries a defect.
  const out = decideReturnRule(WIDE, {
    reason: "BUYER_CHANGED_MIND",
    orderTotalCents: 50_000,
    state: "RETURN_REQUESTED",
  });
  assertEquals(out.decision, "skip");
});

Deno.test("normalizeThresholdCents rejects junk and sub-minimum values", () => {
  assertEquals(normalizeThresholdCents(null), null);
  assertEquals(normalizeThresholdCents(""), null);
  assertEquals(normalizeThresholdCents("abc"), null);
  assertEquals(normalizeThresholdCents(0), null);
  assertEquals(normalizeThresholdCents(MIN_RETURN_THRESHOLD_CENTS - 1), null);
  assertEquals(normalizeThresholdCents(MIN_RETURN_THRESHOLD_CENTS), MIN_RETURN_THRESHOLD_CENTS);
  assertEquals(normalizeThresholdCents(9_999_999), 100_000);
});

Deno.test("the dry run counts and explains every return it looked at", () => {
  const summary = dryRunReturnRule(WIDE, [
    { externalId: "r1", reason: "BUYER_CHANGED_MIND", orderTotalCents: 1_000, state: "RETURN_REQUESTED" },
    { externalId: "r2", reason: "BUYER_CHANGED_MIND", orderTotalCents: 6_000, state: "RETURN_REQUESTED" },
    { externalId: "r3", reason: "NOT_AS_DESCRIBED", orderTotalCents: 500, state: "RETURN_REQUESTED" },
  ]);
  assertEquals(summary.considered, 3);
  assertEquals(summary.wouldRefundKeep, 1);
  assertEquals(summary.wouldApprove, 1);
  assertEquals(summary.skipped, 1);
  assertEquals(summary.lines.length, 3, "every return gets a line, including the skips");
  assert(summary.lines.every((l) => l.reason.length > 0));
});
