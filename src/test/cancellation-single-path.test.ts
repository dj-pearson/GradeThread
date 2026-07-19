// US-2125: there must be exactly ONE cancellation experience.
//
// The reviewed flow is good — self-serve, ~4 clicks, period-end timing stated on
// every screen, a required acknowledgement checkbox, clearly-labelled escape
// buttons, and an undo banner afterwards. The defect was a SECOND path:
// selecting the Free tile in the plan picker opened the Stripe billing portal
// instead, which has none of that.
//
// A divergent second route is how an audited flow stops being the one users
// actually hit. This guard exists because that route was a single line and will
// look like a reasonable shortcut to the next person.
//
// SCOPE, stated so the guard is not misread: using the billing portal is FINE.
// It is the right tool for updating a payment method (past-due-banner) and for
// Stripe-side account management. What must not happen is a CANCELLATION being
// routed there, because cancellation is the flow with the review requirements.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("US-2125: one reviewed cancellation path", () => {
  it("the Free tile routes to the reviewed dialog, not the Stripe portal", () => {
    const src = read("src/components/billing/flipdesk-plan-picker-dialog.tsx");

    // The cancel branch must short-circuit BEFORE portal.mutate().
    const handler = src.slice(
      src.indexOf("onOpenPortal:"),
      src.indexOf("onOpenPortal:") + 900,
    );
    const cancelGuard = handler.indexOf("isCancelToFree");
    const portalCall = handler.indexOf("portal.mutate()");

    expect(cancelGuard, "the Free tile must be special-cased").toBeGreaterThan(-1);
    expect(portalCall, "portal.mutate should still exist for non-cancel uses")
      .toBeGreaterThan(-1);
    expect(
      cancelGuard,
      "the isCancelToFree branch must come BEFORE portal.mutate() and return — " +
        "otherwise a cancellation still reaches the portal",
    ).toBeLessThan(portalCall);
    expect(
      handler.slice(cancelGuard, portalCall),
      "the cancel branch must RETURN, not fall through to the portal",
    ).toMatch(/return;/);
  });

  it("the picker reports cancel intent upward instead of rendering the dialog", () => {
    const src = read("src/components/billing/flipdesk-plan-picker-dialog.tsx");
    expect(src).toMatch(/onRequestCancel/);
    // CancelSubscriptionDialog opens the plan picker as its "switch to a cheaper
    // plan" off-ramp. If the picker ALSO rendered the cancel dialog, the two
    // would be mutually recursive — hence a callback, and hence this assertion.
    expect(
      src.includes("<CancelSubscriptionDialog"),
      "the picker must NOT render CancelSubscriptionDialog — the cancel dialog " +
        "already opens the picker, so self-rendering makes them mutually recursive",
    ).toBe(false);
  });

  it("billing.tsx wires the picker's cancel intent to the reviewed dialog", () => {
    const src = read("src/pages/billing.tsx");
    expect(src).toMatch(/onRequestCancel=\{\(\) => setCancelOpen\(true\)\}/);
  });

  // The portal is legitimate for payment-method management; this documents the
  // distinction so a future reader doesn't "fix" past-due-banner by mistake.
  it("the past-due banner may still use the portal — that is payment-method management", () => {
    const src = read("src/components/billing/past-due-banner.tsx");
    expect(src).toMatch(/portal\.mutate\(\)/);
    expect(
      src.toLowerCase().includes("cancel"),
      "the past-due banner should not be offering cancellation",
    ).toBe(false);
  });
});
