// Confirming the "these specifics have no match in the new category" dialog
// must APPLY the new category, not quietly revert it.
//
// THE DEFECT THIS EXISTS FOR. `AlertDialogAction` closes the dialog when it is
// clicked, and closing fires `onOpenChange(false)`, which called
// `cancelDiscard()` — the same function Escape and the overlay use. So the
// confirm button ran `confirmDiscard()` and was then undone a moment later by
// its own close event, resetting `categoryId` to `fromCategoryId`. On an item
// with no category saved yet that value is `null`, so accepting a new category
// blanked the picker back to its search box and no specifics ever rendered.
//
// It looked like a data problem (eBay returned nothing) and it was a wiring
// one. Picking the same category a second time appeared to fix it, because by
// then `appliedCategoryRef` matched and no dialog opened to undo the choice —
// which is exactly the kind of "works on the second try" behaviour that gets
// reported as flakiness and never found.
//
// Asserted against source text: reproducing it needs a real Radix dialog, an
// eBay taxonomy fetch and a query client, and the thing that broke is which
// function the close handler calls — a fact the source states directly.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PICKER = "src/components/flipdesk/ebay-category-picker.tsx";
const source = readFileSync(resolve(process.cwd(), PICKER), "utf8");

/** The body of the discard dialog's onOpenChange handler. */
function onOpenChangeBody(): string {
  const at = source.indexOf("open={!!pendingDiscard}");
  expect(at, "the discard dialog moved or was renamed").toBeGreaterThan(-1);
  const from = source.indexOf("onOpenChange", at);
  return source.slice(from, source.indexOf("<AlertDialogContent>", from));
}

describe("category-change discard dialog", () => {
  it("distinguishes confirming from dismissing", () => {
    // Without this guard the close event cannot tell the two apart, and the
    // confirm path is the one that loses.
    expect(source).toContain("discardConfirmedRef");
    expect(onOpenChangeBody()).toContain("discardConfirmedRef.current");
  });

  it("still reverts on Escape or an overlay click", () => {
    // The dialog's whole purpose is that dismissing it keeps the current
    // category. Fixing the confirm path must not silently drop that.
    expect(onOpenChangeBody()).toContain("cancelDiscard()");
  });

  it("confirming marks itself BEFORE clearing the pending state", () => {
    // Order matters: setPendingDiscard(null) is what closes the dialog, so the
    // flag has to be set first or the close handler reads a stale `false`.
    const fn = source.slice(
      source.indexOf("function confirmDiscard()"),
      source.indexOf("function cancelDiscard()"),
    );
    expect(fn).toContain("discardConfirmedRef.current = true");
    expect(fn.indexOf("discardConfirmedRef.current = true")).toBeLessThan(
      fn.indexOf("setPendingDiscard(null)"),
    );
  });

  it("confirming applies the NEW category, not the one being replaced", () => {
    const fn = source.slice(
      source.indexOf("function confirmDiscard()"),
      source.indexOf("function cancelDiscard()"),
    );
    expect(fn).toContain("pendingDiscard.toCategoryId");
    expect(fn).not.toContain("fromCategoryId");
  });
});
