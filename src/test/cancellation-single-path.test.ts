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
  // ⚠ THIS CASE USED TO PIN A WEAKER SHAPE, and the difference is the point.
  // It asserted that an `isCancelToFree` branch sat inside `onOpenPortal` and
  // returned before `portal.mutate()`. That was true and still left one handler
  // meaning two things — which is exactly how the bug survived: the routing was
  // corrected while a comment two hundred lines away still said "goes through
  // the portal until US-216's cancel flow ships", and the button it described
  // was wired to the portal handler. Nothing could disagree with it. The two
  // paths are now separate props, so they cannot be confused by a future edit,
  // and this case pins THAT rather than the ordering inside a shared branch.
  it("the Free tile calls onCancel, and onCancel never reaches the portal", () => {
    const src = read("src/components/billing/flipdesk-plan-picker-dialog.tsx");

    const cancelHandler = src.slice(
      src.indexOf("onCancel: () => {"),
      src.indexOf("onCancel: () => {") + 500,
    );
    expect(
      src.indexOf("onCancel: () => {"),
      "the cancel path must be its own prop, not a branch inside onOpenPortal",
    ).toBeGreaterThan(-1);
    expect(
      cancelHandler.includes("portal.mutate()"),
      "onCancel must not open the Stripe portal — that is the whole defect",
    ).toBe(false);
    expect(
      cancelHandler,
      "onCancel must hand the intent to the reviewed dialog",
    ).toMatch(/onRequestCancel\?\.\(\)/);

    // And the button the seller actually clicks has to be wired to it. Without
    // this, onCancel could be correct and unreferenced while the Cancel button
    // still called onOpenPortal — which is the state this file just caught.
    const cancelBtn = src.slice(
      src.indexOf("if (isCancelToFree) {"),
      src.indexOf("if (isCancelToFree) {") + 700,
    );
    expect(
      cancelBtn,
      "the Cancel subscription button must call onCancel",
    ).toMatch(/onClick=\{onCancel\}/);
    expect(
      cancelBtn.includes("onClick={onOpenPortal}"),
      "the Cancel subscription button is still wired to the portal handler",
    ).toBe(false);

    // The portal itself stays — it is how the interval switch works.
    expect(
      src.includes("portal.mutate()"),
      "portal.mutate should still exist for the interval switch",
    ).toBe(true);
  });

  it("no stale comment claims cancellation goes through the portal", () => {
    // The routing was fixed before this comment was, and the comment is what a
    // reader trusts. It named a story (US-216) that had already shipped.
    const src = read("src/components/billing/flipdesk-plan-picker-dialog.tsx");
    expect(
      /until US-216/.test(src),
      "the stale 'until US-216 ships' comment is back",
    ).toBe(false);
    expect(
      /Cancelling to Free goes through the portal/.test(src),
      "a comment still says cancellation goes through the portal",
    ).toBe(false);
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
