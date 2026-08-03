// US-2256: the composer had no unsaved-changes guard. Thirteen cards of edits —
// title, price, specifics, measurements, photos' primary pick, cost, promote,
// Best Offer — vanished on one click of "Close", one sidebar click, or one
// refresh, with nothing said.
//
// The behaviour lives in React state + React Router's blocker, so it is asserted
// against the composer source (this repo's convention for wiring that can rot
// silently — see photo-manager-seams.test.ts). Each assertion below corresponds
// to a specific way this guard can quietly stop working.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The dirty guard is the PAGE's job — it owns the form state and the blocker.
import { composerPage as composer } from "./helpers/composer-source";

const sheet = readFileSync(
  join(process.cwd(), "src/components/flipdesk/item-detail-dialog.tsx"),
  "utf8",
);

describe("composer unsaved-changes guard (US-2256)", () => {
  it("guards in-app navigation and page unload via the shared hook", () => {
    // useNavigationGuard (US-2032) covers BOTH useBlocker and beforeunload.
    // Rolling a bare beforeunload here instead would silently drop the in-app case.
    expect(composer).toContain(
      'import { useNavigationGuard } from "@/hooks/use-navigation-guard"',
    );
    expect(composer).toContain("useNavigationGuard(isDirty && !saving)");
  });

  it("does not block while a save is in flight", () => {
    // Blocking mid-save would trap the seller behind a dialog about work that is
    // in the middle of being persisted.
    expect(composer).toMatch(/useNavigationGuard\(isDirty && !saving\)/);
  });

  it("renders a confirm dialog rather than only relying on the browser prompt", () => {
    expect(composer).toContain("open={guard.blocked}");
    expect(composer).toContain("Leave without saving?");
    expect(composer).toContain("guard.confirmLeave");
    expect(composer).toContain("guard.cancelLeave");
  });

  it("treats a pristine, still-loading form as clean", () => {
    // savedSnapshot starts null and is only stamped once seeding finishes, so a
    // form mid-load can never look dirty.
    expect(composer).toContain(
      "if (initialised && savedSnapshot === null) setSavedSnapshot(formSnapshot);",
    );
    expect(composer).toMatch(
      /savedSnapshot !== null && formSnapshot !== savedSnapshot/,
    );
  });

  it("clears the dirty flag after every successful save path", () => {
    // Two save paths (draft + live revise). Both must re-stamp, or the guard
    // fires on a form the seller just saved — the fastest way to teach someone
    // to click through it. One definition + two calls.
    expect(composer.match(/\bmarkSaved\(/g)?.length).toBe(3);
    expect(composer).toContain("function markSaved(");
    expect(composer).toContain("setAspectsDirty(false);");
  });

  it("stamps fields the SAVE changed as saved, not as a fresh edit", () => {
    // The eBay-leaf → coarse-category cascade updates item_category during the
    // save, so the post-save form legitimately differs from the pre-save one.
    // Stamping the pre-cascade snapshot would leave the composer permanently
    // dirty the instant it finished saving — the guard firing on work that IS
    // saved is the same wolf-crying failure as it never firing.
    expect(composer).toContain("function markSaved(overrides?");
    expect(composer).toMatch(
      /JSON\.stringify\(\{ \.\.\.snapshotValues, \.\.\.overrides \}\)/,
    );
    expect(composer).toContain("markSaved(syncCascadedCategory(itemPatch))");
  });

  it("does not count the aspect picker's own mount report as a seller edit", () => {
    // The eBay category picker reports its aspect map up on mount, after its own
    // prefill. Folding that into the snapshot would make a freshly-opened
    // composer look dirty before anyone touched it.
    expect(composer).toContain("if (aspectBaseline.current === null)");
    expect(composer).toContain("setAspectsDirty(true)");
  });

  it("keeps the aspect map out of the form snapshot", () => {
    // Both memos: the keyed value object and the string derived from it.
    const snapshot = composer.slice(
      composer.indexOf("const snapshotValues = useMemo("),
      composer.indexOf("// Stamped once seeding finishes"),
    );
    expect(snapshot.length).toBeGreaterThan(100);
    expect(snapshot).not.toContain("livePickedAspects");
    expect(snapshot).not.toContain("resolvedAspects");
  });

  it("covers the fields a seller would be angriest to lose", () => {
    // Both memos: the keyed value object and the string derived from it.
    const snapshot = composer.slice(
      composer.indexOf("const snapshotValues = useMemo("),
      composer.indexOf("// Stamped once seeding finishes"),
    );
    for (const field of [
      "title",
      "description",
      "price",
      "cost",
      "quantity",
      "measurements",
      "primaryPhotoId",
      "conditionDesc",
      "bestOfferAccept",
      "storageSku",
      "shippingPolicyId",
      // US-2382 removed "badgeEnabled" from this list along with the state
      // itself. It was never a field a seller could be angry to lose: the
      // switch wrote two columns nothing read, so losing the value cost
      // nothing. The switch is gone, not merely unhooked from the guard.
      "listingFormat",
      "scheduledAt",
    ]) {
      expect(snapshot, field).toContain(field);
    }
  });
});

describe("the quick-look sheet runs its own confirm (US-2256)", () => {
  it("subscribes to the composer's dirty state", () => {
    // The blocker only sees route changes; closing a sheet is not one.
    expect(sheet).toContain("onDirtyChange={setDirty}");
  });

  it("confirms on every dismissal path, not just the X button", () => {
    // onOpenChange covers Escape and the overlay click.
    expect(sheet).toContain('if (!o) leave("close");');
    expect(sheet).toContain('onClick={() => leave("close")}');
    // Navigating to the full page also abandons the sheet's edits.
    expect(sheet).toContain('onClick={() => leave("fullPage")}');
  });

  it("closes straight through when there is nothing to lose", () => {
    expect(sheet).toMatch(/if \(dirty\) \{\s*setConfirming\(intent\);\s*return;/);
  });

  it("tells the seller there is unsaved work before they try to leave", () => {
    expect(sheet).toContain("Unsaved changes");
  });
});
