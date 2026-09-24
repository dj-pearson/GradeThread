import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { draftAutosaveAction } from "@/hooks/use-submission-draft";

// SNAP-05: a snap/retake arrival must not wipe or overwrite an unrelated saved
// draft, must not stay pinned in history state, and must stop claiming the
// Front photo is the snap once the seller replaced it.

const src = readFileSync(resolve(process.cwd(), "src/pages/new-submission.tsx"), "utf8");

describe("draftAutosaveAction", () => {
  const base = { resolved: true, ready: true, bridgeArrival: false, userTouched: false, hasContent: false };

  it("a bridge arrival writes nothing until the seller edits", () => {
    // Before the fix this path was "clear" and deleted the saved draft.
    expect(draftAutosaveAction({ ...base, bridgeArrival: true })).toBe("skip");
    // And the seeded snap photo alone must not overwrite it either.
    expect(draftAutosaveAction({ ...base, bridgeArrival: true, hasContent: true })).toBe("skip");
  });

  it("after the seller's own edit, a bridge arrival autosaves as usual", () => {
    expect(draftAutosaveAction({ ...base, bridgeArrival: true, userTouched: true, hasContent: true })).toBe("save");
  });

  it("a plain visit is unchanged", () => {
    expect(draftAutosaveAction({ ...base })).toBe("clear");
    expect(draftAutosaveAction({ ...base, hasContent: true })).toBe("save");
    expect(draftAutosaveAction({ ...base, resolved: false, hasContent: true })).toBe("skip");
    expect(draftAutosaveAction({ ...base, ready: false, hasContent: true })).toBe("skip");
  });
});

describe("the page latches the bridge (source)", () => {
  it("reads location.state once, in a state initializer", () => {
    expect(src).toMatch(/const \[snapState\] = useState\(\s*\(\) =>/);
    expect(src).toMatch(/const \[retakeState\] = useState\(\s*\(\) =>/);
  });

  it("clears history state on arrival", () => {
    expect(src).toContain("navigate(location.pathname + location.search, { replace: true, state: null });");
  });

  it("the autosave goes through the guarded decision", () => {
    expect(src).toContain("draftAutosaveAction({");
    expect(src).toContain("userTouched: userTouchedRef.current");
    expect(src).toContain("userTouchedRef.current = true;");
  });

  it("offers the set-aside draft and hides the carried-over banner once Front is replaced", () => {
    expect(src).toContain("Resume that draft instead");
    expect(src).toContain("front.file === seededFrontRef.current");
    expect(src).toContain("{snapFrontFile && snapFrontStillSeeded && (");
  });
});
