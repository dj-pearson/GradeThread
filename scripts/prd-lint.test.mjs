// US-1612: vitest coverage for the prd.json linter (Node env — see
// vitest.scripts.config.mjs). Fixtures are inline prd objects.
import { describe, expect, it } from "vitest";
import { accumulationReminder, findCycles, lintPrd, parseIdNum } from "./prd-lint.mjs";

const story = (over = {}) => ({ id: "US-1", title: "t", description: "d", acceptanceCriteria: ["a"], passes: false, ...over });
const prd = (userStories, nextId = 10_000) => ({ nextId, userStories });

describe("parseIdNum", () => {
  it("parses US-N, NaN otherwise", () => {
    expect(parseIdNum("US-42")).toBe(42);
    expect(Number.isNaN(parseIdNum("nope"))).toBe(true);
  });
});

describe("lintPrd — nextId", () => {
  it("errors when nextId <= max active id", () => {
    const r = lintPrd({ prd: prd([story({ id: "US-5" })], 5) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("nextId"))).toBe(true);
  });
  it("enforces the archive max via the probe result", () => {
    const r = lintPrd({ prd: prd([story({ id: "US-3" })], 10), archiveMaxId: 20 });
    expect(r.errors.some((e) => e.includes("archive max 20"))).toBe(true);
  });
  it("passes when nextId beats every id anywhere", () => {
    const r = lintPrd({ prd: prd([story({ id: "US-3" })], 21), archiveMaxId: 20 });
    expect(r.ok).toBe(true);
  });
});

describe("lintPrd — structure", () => {
  it("flags duplicate ids", () => {
    const r = lintPrd({ prd: prd([story(), story()]) });
    expect(r.errors.some((e) => e.includes("duplicate id: US-1"))).toBe(true);
  });
  it("flags missing required fields + wrong types", () => {
    const r = lintPrd({ prd: prd([{ id: "US-1", title: "t", passes: "yes" }]) });
    expect(r.errors.some((e) => e.includes('missing required field "description"'))).toBe(true);
    expect(r.errors.some((e) => e.includes('missing required field "acceptanceCriteria"'))).toBe(true);
    expect(r.errors.some((e) => e.includes("passes must be a boolean"))).toBe(true);
  });
});

describe("lintPrd — dependsOn", () => {
  it("flags a reference to an id that exists nowhere", () => {
    const r = lintPrd({ prd: prd([story({ dependsOn: ["US-999"] })]) });
    expect(r.errors.some((e) => e.includes("unknown id US-999"))).toBe(true);
  });
  it("accepts a dependency on an archived id", () => {
    const r = lintPrd({ prd: prd([story({ dependsOn: ["US-50"] })]), archiveIds: new Set(["US-50"]) });
    expect(r.errors.some((e) => e.includes("unknown"))).toBe(false);
  });
  it("detects a cycle", () => {
    const r = lintPrd({
      prd: prd([story({ id: "US-1", dependsOn: ["US-2"] }), story({ id: "US-2", dependsOn: ["US-1"] })]),
    });
    expect(r.errors.some((e) => e.includes("cycle"))).toBe(true);
  });
});

describe("findCycles", () => {
  it("finds a 3-node cycle once, ignores acyclic + external edges", () => {
    expect(findCycles(new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]]))).toHaveLength(1);
    expect(findCycles(new Map([["a", ["b"]], ["b", []]]))).toHaveLength(0);
    // an edge to a node not in the graph (archive/leaf) never cycles
    expect(findCycles(new Map([["a", ["external"]]]))).toHaveLength(0);
  });
});

describe("lintPrd — guards are warnings, not errors", () => {
  it("warns (does not fail) on accumulation past the threshold", () => {
    const many = Array.from({ length: 60 }, (_, i) => story({ id: `US-${i + 1}`, passes: true }));
    const r = lintPrd({ prd: prd(many), opts: { accumulationThreshold: 50 } });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("re-archive"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("stop-ralph"))).toBe(true); // the verbatim procedure
  });
  it("warns on an oversized LEARNINGS.md", () => {
    const r = lintPrd({ prd: prd([]), learningsLines: 900, opts: { learningsLineWarn: 800 } });
    expect(r.warnings.some((w) => w.includes("LEARNINGS.md"))).toBe(true);
  });
  it("a clean backlog is ok with no errors", () => {
    const r = lintPrd({ prd: prd([story()]) });
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
});

describe("accumulationReminder", () => {
  it("carries the stop-the-loop-first procedure verbatim", () => {
    const msg = accumulationReminder(685, 50);
    expect(msg).toContain("STOP THE RALPH LOOP FIRST");
    expect(msg).toContain("scripts/ralph/stop-ralph.sh");
    expect(msg).toContain("NEVER let the linter or an agent");
  });
});
