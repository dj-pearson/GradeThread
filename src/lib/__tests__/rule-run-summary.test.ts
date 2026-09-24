import { describe, expect, it } from "vitest";
import { ruleRunToast } from "../rule-run-summary";

describe("ruleRunToast", () => {
  it("says a second run is already going instead of claiming zero changes", () => {
    expect(ruleRunToast({ reason: "already_running", applied: 0 })).toEqual({
      kind: "info",
      text: "A run is already in progress.",
    });
  });

  it("reports failures next to what applied", () => {
    expect(ruleRunToast({ applied: 3, errors: 12 })).toEqual({
      kind: "warning",
      text: "3 applied, 12 failed, see Activity.",
    });
  });

  it("names what was checked when the server says", () => {
    expect(ruleRunToast({ applied: 1, errors: 0, listings_scanned: 40 }, "action").text).toBe(
      "Checked 40 listings. 1 action applied.",
    );
  });

  it("never uses an em dash", () => {
    for (const r of [{ applied: 2 }, { applied: 0, errors: 1 }, { reason: "already_running" }]) {
      expect(ruleRunToast(r).text).not.toContain("\u2014");
    }
  });
});
