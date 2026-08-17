// The operator queue's SATISFIED marker.
//
// WHY THE MARKER EXISTS. The queue lists what a person still has to do, and it
// reads ACCEPTANCE CRITERIA. Notes already record that a step was done, but the
// criterion text does not change — so a finished operator item kept reappearing
// at the top of "START HERE" with five other stories named as waiting on it.
// A list with finished items on it stops being read, which is the same failure
// that let a CI lane sit red for three weeks.
//
// It requires a DATE on purpose: "SATISFIED" alone is a claim, "SATISFIED
// 2026-08-17" is a claim with a when. And satisfied items are COUNTED rather
// than dropped — an item that vanishes without trace is indistinguishable from
// one nobody ever wrote down.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collect, DECLARED_RE, SATISFIED_RE } from "./prd-operator.mjs";

const story = (id, acs) => ({
  id,
  passes: false,
  title: `story ${id}`,
  acceptanceCriteria: acs,
  notes: "",
});

describe("SATISFIED marker", () => {
  it("requires a date, so a bare claim still counts as work", () => {
    expect(SATISFIED_RE.test("OPERATOR: do the thing — SATISFIED 2026-08-17: proof")).toBe(true);
    expect(SATISFIED_RE.test("OPERATOR: do the thing — SATISFIED")).toBe(false);
    expect(SATISFIED_RE.test("OPERATOR: do the thing — satisfied soon")).toBe(false);
  });

  it("drops the satisfied item from the queue and counts it", () => {
    const r = collect([
      story("US-1", [
        "OPERATOR: still to do",
        "OPERATOR: already done — SATISFIED 2026-08-17: measured",
      ]),
    ]);
    expect(r.satisfied).toBe(1);
    expect(r.declared).toHaveLength(1);
    expect(r.declared[0].items).toEqual(["OPERATOR: still to do"]);
  });

  it("a story whose ONLY operator item is satisfied leaves the declared list", () => {
    // The case that matters: the story stops being an operator row at all
    // rather than showing up with an empty item list.
    const r = collect([
      story("US-2", ["OPERATOR: done — SATISFIED 2026-08-17: proof"]),
    ]);
    expect(r.satisfied).toBe(1);
    expect(r.declared.find((d) => d.id === "US-2")).toBeUndefined();
  });

  it("does not touch an unsatisfied queue", () => {
    const r = collect([story("US-3", ["OPERATOR: rotate the key"])]);
    expect(r.satisfied).toBe(0);
    expect(r.declared[0].items).toHaveLength(1);
  });

  it("still recognises the criterion as declared operator work", () => {
    // The marker is a suffix, not a replacement: the text must keep its
    // OPERATOR: prefix so a reader (and any other consumer) still sees what it
    // was, and so removing the marker restores it to the queue.
    const ac = "OPERATOR: read the health line — SATISFIED 2026-08-17: proof";
    expect(DECLARED_RE.test(ac)).toBe(true);
  });

  it("a satisfied story is not silently reclassified as undeclared", () => {
    // Without care, filtering the ACs to empty would fall through to the
    // prose-scanning branch and re-list the story from a note sentence — the
    // same row back under a weaker heading.
    const s = story("US-4", ["OPERATOR: done — SATISFIED 2026-08-17: proof"]);
    s.notes = "This is operator work and cannot be done from here.";
    const r = collect([s]);
    expect(r.declared.find((d) => d.id === "US-4")).toBeUndefined();
    expect(r.undeclared.find((d) => d.id === "US-4")).toBeUndefined();
  });
});

describe("the marker is documented where it is used", () => {
  it("prd-operator.mjs explains the convention", () => {
    const src = readFileSync(resolve(process.cwd(), "scripts/prd-operator.mjs"), "utf8");
    expect(src).toContain("SATISFIED_RE");
    // The count must be reported, not just computed.
    expect(src).toMatch(/marked SATISFIED with a date/);
  });
});
