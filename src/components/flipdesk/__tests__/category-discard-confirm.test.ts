// Changing the eBay category APPLIES IMMEDIATELY. There is no confirm step.
//
// HISTORY, because this reversed a deliberate decision. US-824 held the change
// behind an AlertDialog whenever specifics would not carry over, so the seller
// could not lose work silently. It had two problems and the owner removed it on
// 2026-08-03:
//
//   1. It described a loss that does not happen. Dropped values are PARKED —
//      switch back, or pick a category that supports them, and they return. A
//      blocking confirm is the weight of "about to delete your work".
//   2. It broke the thing it gated. `AlertDialogAction` closes the dialog on
//      click, closing fired `onOpenChange(false)`, and that ran the same
//      `cancelDiscard()` used by Escape — which reverted `categoryId` to the
//      category being replaced. On an item with no saved category that is
//      `null`, so confirming a change blanked the picker back to its search
//      box and no specifics rendered. Guarding the confirm path fixed the
//      revert; deleting the dialog removed the class of bug.
//
// What replaced it is a toast: same information, no click, no state to get
// wrong. This file exists so the dialog does not come back by reflex — if a
// future change needs one, it needs to answer (2) first.
//
// Asserted against source text: the removed thing is a component and a handler,
// and their absence is what matters.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PICKER = "src/components/flipdesk/ebay-category-picker.tsx";
const source = readFileSync(resolve(process.cwd(), PICKER), "utf8");

describe("changing category applies without a confirm step", () => {
  it("has no discard dialog, and no state or handlers behind one", () => {
    for (const gone of [
      "AlertDialog",
      "pendingDiscard",
      "confirmDiscard",
      "cancelDiscard",
      "discardConfirmedRef",
    ]) {
      expect(source, `${gone} should be gone with the confirm step`).not.toContain(
        gone,
      );
    }
  });

  it("commits the remap on every category change, gated by nothing", () => {
    // The old code returned early before commitRemap when values would drop.
    // That early return IS the bug surface: everything after it — the applied
    // refs, the new aspect values — only ran if a dialog came back.
    const effect = source.slice(
      source.indexOf("const isInitial = appliedCategoryRef.current === categoryId"),
      source.indexOf("}, [aspectsQuery.data, itemFieldsRemapKey]);"),
    );
    expect(effect).toContain("commitRemap(aspectList, result)");
    expect(effect).not.toMatch(/\breturn;\s*$/m);
  });

  it("still tells the seller what was set aside", () => {
    // Removing the confirm is not the same as removing the information. If this
    // ever goes, specifics really do vanish silently.
    const effect = source.slice(
      source.indexOf("const droppedNames = Object.keys(result.dropped)"),
      source.indexOf("commitRemap(aspectList, result)"),
    );
    expect(effect).toContain("toast");
    expect(effect.toLowerCase()).toContain("set aside");
  });

  it("says nothing on first load or a refetch", () => {
    // `isInitial` is what separates a user switching category from the spec
    // arriving. Without it, opening a draft would toast about specifics the
    // seller never touched.
    const effect = source.slice(
      source.indexOf("const isInitial = appliedCategoryRef.current === categoryId"),
      source.indexOf("commitRemap(aspectList, result)"),
    );
    expect(effect).toContain("!isInitial");
  });
});
