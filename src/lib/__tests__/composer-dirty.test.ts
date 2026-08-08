import { describe, expect, it } from "vitest";
import {
  INITIAL_ASPECT_DIRTY_STATE,
  reduceAspectReport,
  stampAspectsSaved,
} from "../composer-dirty";

const SAVED = JSON.stringify({ Brand: ["Chiara Boni"] });
const PREFILLED = JSON.stringify({
  Brand: ["Chiara Boni"],
  Department: ["Women"],
});
const EDITED = JSON.stringify({
  Brand: ["Chiara Boni"],
  Department: ["Women"],
  Type: ["Basic"],
});

describe("aspect dirty state", () => {
  it("does not go dirty when the picker rewrites its own map before any edit", () => {
    // The real open sequence: first report is the saved map, then the spec
    // arrives and the deterministic remap adds Department, then the
    // Measurements projection fires. Nobody has touched anything.
    let s = INITIAL_ASPECT_DIRTY_STATE;
    s = reduceAspectReport(s, SAVED, false);
    s = reduceAspectReport(s, PREFILLED, false);
    s = reduceAspectReport(s, PREFILLED, false);
    expect(s.dirty).toBe(false);
    // The baseline followed the picker, so a later edit is measured against
    // what was actually on screen — not against a map the seller never saw.
    expect(s.baseline).toBe(PREFILLED);
  });

  it("goes dirty on a report that follows a seller edit", () => {
    let s = reduceAspectReport(INITIAL_ASPECT_DIRTY_STATE, PREFILLED, false);
    s = reduceAspectReport(s, EDITED, true);
    expect(s.dirty).toBe(true);
  });

  it("stays clean when a post-edit report changes nothing", () => {
    // The lift effect re-runs on unrelated composer renders. An identical map
    // is not an edit.
    let s = reduceAspectReport(INITIAL_ASPECT_DIRTY_STATE, PREFILLED, false);
    s = reduceAspectReport(s, PREFILLED, true);
    expect(s.dirty).toBe(false);
  });

  it("stays dirty once dirty, even if a later report matches the baseline", () => {
    let s = reduceAspectReport(INITIAL_ASPECT_DIRTY_STATE, PREFILLED, false);
    s = reduceAspectReport(s, EDITED, true);
    s = reduceAspectReport(s, PREFILLED, true);
    expect(s.dirty).toBe(true);
  });

  it("a save clears dirty by re-stamping, and the latch does not reopen it", () => {
    let s = reduceAspectReport(INITIAL_ASPECT_DIRTY_STATE, PREFILLED, false);
    s = reduceAspectReport(s, EDITED, true);
    expect(s.dirty).toBe(true);
    s = stampAspectsSaved(EDITED);
    expect(s).toEqual({ baseline: EDITED, dirty: false });
    // Still latched — the seller edited earlier this session — but the saved
    // map now matches, so re-reporting it is not unsaved work.
    s = reduceAspectReport(s, EDITED, true);
    expect(s.dirty).toBe(false);
  });
});
