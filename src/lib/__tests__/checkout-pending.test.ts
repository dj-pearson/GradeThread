// US-797: post-checkout reconciliation logic. Covers the sessionStorage marker
// round-trip and the pure tick decision — including the webhook-lands-after-
// navigation convergence and the bounded-window timeout.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  billingSignature,
  CHECKOUT_RECONCILE_WINDOW_MS,
  clearCheckoutPending,
  markCheckoutPending,
  nextReconcileAction,
  readCheckoutPending,
} from "@/lib/checkout-pending";

describe("checkout-pending marker", () => {
  beforeEach(() => clearCheckoutPending());
  afterEach(() => clearCheckoutPending());

  it("round-trips a subscription marker", () => {
    markCheckoutPending("subscription", 1000);
    expect(readCheckoutPending()).toEqual({ since: 1000, kind: "subscription" });
  });

  it("round-trips a credit_pack marker", () => {
    markCheckoutPending("credit_pack", 2000);
    expect(readCheckoutPending()).toEqual({ since: 2000, kind: "credit_pack" });
  });

  it("returns null when unset and after clear", () => {
    expect(readCheckoutPending()).toBeNull();
    markCheckoutPending("subscription");
    clearCheckoutPending();
    expect(readCheckoutPending()).toBeNull();
  });

  it("ignores a malformed/foreign marker", () => {
    sessionStorage.setItem("gt.billing.checkout_pending", '{"kind":"bogus"}');
    expect(readCheckoutPending()).toBeNull();
  });
});

describe("billingSignature", () => {
  it("is null for missing summary", () => {
    expect(billingSignature(null)).toBeNull();
    expect(billingSignature(undefined)).toBeNull();
  });

  it("encodes plan + credit balance", () => {
    expect(
      billingSignature({ subscription: { plan: "free" }, grades: { credit_balance: 0 } }),
    ).toBe("free:0");
    expect(
      billingSignature({ subscription: { plan: "business" }, grades: { credit_balance: 5 } }),
    ).toBe("business:5");
  });
});

describe("nextReconcileAction", () => {
  const since = 0;

  it("captures the first observed summary as the baseline", () => {
    expect(
      nextReconcileAction({ baseline: null, currentSig: "free:0", since, now: 1000 }),
    ).toBe("set-baseline");
  });

  it("keeps polling while no summary is cached yet", () => {
    expect(
      nextReconcileAction({ baseline: null, currentSig: null, since, now: 1000 }),
    ).toBe("poll");
  });

  it("keeps polling while the summary is unchanged within the window", () => {
    expect(
      nextReconcileAction({ baseline: "free:0", currentSig: "free:0", since, now: 5000 }),
    ).toBe("poll");
  });

  it("reports reconciled once the plan flips (webhook landed after navigation)", () => {
    expect(
      nextReconcileAction({ baseline: "free:0", currentSig: "business:0", since, now: 5000 }),
    ).toBe("reconciled");
  });

  it("reports reconciled once the credit balance moves", () => {
    expect(
      nextReconcileAction({ baseline: "business:0", currentSig: "business:25", since, now: 5000 }),
    ).toBe("reconciled");
  });

  it("a change is detected even right at the window boundary (reconciled beats timeout)", () => {
    expect(
      nextReconcileAction({
        baseline: "free:0",
        currentSig: "business:0",
        since,
        now: CHECKOUT_RECONCILE_WINDOW_MS,
      }),
    ).toBe("reconciled");
  });

  it("times out when the window elapses with no change", () => {
    expect(
      nextReconcileAction({
        baseline: "free:0",
        currentSig: "free:0",
        since,
        now: CHECKOUT_RECONCILE_WINDOW_MS,
      }),
    ).toBe("timeout");
  });
});
