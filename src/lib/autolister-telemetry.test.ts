import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptAll, rejectAll } from "./analytics";
import {
  confidenceBucket,
  groupingCorrectionScore,
  manualGroupsCreated,
  trackAiSuggestion,
  trackAutogroupRun,
  trackGroupEdit,
  trackGroupingOutcome,
} from "./autolister-telemetry";

// US-1908: grouping-quality telemetry. The correction-score helper drives the
// tuning dashboards, and NO event may fire before analytics consent.

function stubCapture() {
  const capture = vi.fn();
  (window as unknown as { posthog?: { capture: typeof capture } }).posthog = { capture };
  return capture;
}

describe("groupingCorrectionScore", () => {
  it("is 0 when the seller changed nothing", () => {
    const snap = { p1: "g1", p2: "g1", p3: "g2" };
    expect(groupingCorrectionScore(snap, snap)).toEqual({ corrected: 0, total: 3, pct: 0 });
  });

  it("counts photos whose final group differs from the auto group", () => {
    const auto = { p1: "g1", p2: "g1", p3: "g2", p4: "g2" };
    const final = { p1: "g1", p2: "gNEW", p3: "g2", p4: "g1" }; // p2, p4 corrected
    const r = groupingCorrectionScore(auto, final);
    expect(r).toEqual({ corrected: 2, total: 4, pct: 0.5 });
  });

  it("treats a now-ungrouped photo as corrected", () => {
    expect(groupingCorrectionScore({ p1: "g1" }, { p1: null })).toEqual({
      corrected: 1,
      total: 1,
      pct: 1,
    });
  });

  it("ignores photos the seller grouped entirely by hand (not in the auto snapshot)", () => {
    const auto = { p1: "g1" };
    const final = { p1: "g1", pHand: "gHand" };
    expect(groupingCorrectionScore(auto, final)).toEqual({ corrected: 0, total: 1, pct: 0 });
  });

  it("is 0/0 → pct 0 for an empty auto snapshot", () => {
    expect(groupingCorrectionScore({}, { p1: "g1" })).toEqual({ corrected: 0, total: 0, pct: 0 });
  });
});

describe("manualGroupsCreated", () => {
  it("counts final groups auto-grouping didn't create", () => {
    expect(manualGroupsCreated(["g1", "g2"], ["g1", "g2", "g3", "g4"])).toBe(2);
  });
  it("is 0 when every final group came from auto-grouping", () => {
    expect(manualGroupsCreated(["g1", "g2"], ["g1"])).toBe(0);
  });
});

describe("confidenceBucket", () => {
  it("buckets low/medium/high on 0.5 and 0.8 thresholds", () => {
    expect(confidenceBucket(0.2)).toBe("low");
    expect(confidenceBucket(0.49)).toBe("low");
    expect(confidenceBucket(0.5)).toBe("medium");
    expect(confidenceBucket(0.79)).toBe("medium");
    expect(confidenceBucket(0.8)).toBe("high");
    expect(confidenceBucket(1)).toBe("high");
  });
});

describe("consent gating (US-291)", () => {
  beforeEach(() => {
    localStorage.clear();
    (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag = vi.fn();
  });

  it("fires NO event before analytics consent", () => {
    rejectAll();
    const capture = stubCapture();
    trackAutogroupRun({
      photo_count: 10,
      group_count: 4,
      singleton_count: 1,
      pct_with_exif: 0.5,
      seq_seeded_count: 6,
    });
    trackGroupEdit("move");
    trackAiSuggestion({ source: "verify", action: "applied", confidence: 0.9 });
    trackGroupingOutcome({
      photo_count: 10,
      corrected_count: 2,
      correction_pct: 0.2,
      manual_groups_created: 1,
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("fires after analytics consent, with coarse buckets and no PII", () => {
    acceptAll();
    const capture = stubCapture();
    trackGroupEdit("merge");
    trackAiSuggestion({ source: "verify", action: "dismissed", confidence: 0.9 });
    expect(capture).toHaveBeenCalledWith("autolister_group_edit", { kind: "merge" });
    expect(capture).toHaveBeenCalledWith("autolister_ai_suggestion", {
      source: "verify",
      action: "dismissed",
      confidence_bucket: "high",
    });
  });
});
