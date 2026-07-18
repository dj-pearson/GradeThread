// US-1612: vitest coverage for the prd.json linter (Node env — see
// vitest.scripts.config.mjs). Fixtures are inline prd objects.
import { describe, expect, it } from "vitest";
import { accumulationReminder, findCycles, findUnresolvedDeferrals, lintPrd, parseIdNum } from "./prd-lint.mjs";

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

// US-1996: passes:true while the notes still carry an unresolved blocker.
describe("findUnresolvedDeferrals", () => {
  const story = (id, passes, notes) => ({
    id,
    title: "t",
    description: "d",
    acceptanceCriteria: ["a"],
    passes,
    notes,
  });

  it("flags a passing story whose notes still say DEFERRED", () => {
    // The US-1770 shape: deferred pending a held migration, closed anyway.
    const hits = findUnresolvedDeferrals([
      story("US-1770", true, "Needs the gate. [DEFERRED 2026-07-09] Needs a HELD migration."),
    ]);
    expect(hits.map((h) => h.id)).toEqual(["US-1770"]);
  });

  it("does NOT flag a story whose blocker was resolved by a later note", () => {
    // The US-1883 shape — the reason this must never be a hard error.
    const hits = findUnresolvedDeferrals([
      story(
        "US-1883",
        true,
        "NOT DONE (blocks passes): AC2 socket pin. | CLOSED 2026-07-18 — VERIFIED COMPLETE, the pin landed.",
      ),
    ]);
    expect(hits).toEqual([]);
  });

  it("is not fooled by the DONE inside 'NOT DONE'", () => {
    // Naive resolution matching would see "DONE" in the marker itself and clear
    // a story that is still blocked.
    const hits = findUnresolvedDeferrals([
      story("US-9001", true, "NOT DONE (blocks passes): AC3 never wired."),
    ]);
    expect(hits.map((h) => h.id)).toEqual(["US-9001"]);
  });

  it("ignores open stories — a blocker note on passes:false is just accurate", () => {
    expect(
      findUnresolvedDeferrals([story("US-9002", false, "[DEFERRED 2026-01-01] blocked on hardware")]),
    ).toEqual([]);
  });

  it("ignores passing stories with clean notes, or none at all", () => {
    expect(findUnresolvedDeferrals([story("US-9003", true, "Shipped cleanly.")])).toEqual([]);
    expect(findUnresolvedDeferrals([{ id: "US-9004", passes: true }])).toEqual([]);
    expect(findUnresolvedDeferrals([])).toEqual([]);
  });

  it("surfaces as a WARNING, never an error", () => {
    const res = lintPrd({
      prd: { nextId: 9999, userStories: [story("US-1", true, "[DEFERRED 2026-07-09] pending")] },
      archiveMaxId: 0,
      archiveIds: new Set(),
      learningsLines: 0,
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.warnings.join(" ")).toContain("US-1");
  });

  it("is not fooled by a lowercase prose done later in the notes", () => {
    // THE ORIGINAL BUG. US-1770 was cleared because ~2300 chars after the
    // marker the prose read "best done in a user-present session". Searching
    // long free text for a common English word will always find it, so
    // resolution must be a structured UPPERCASE token in a LATER note segment.
    const hits = findUnresolvedDeferrals([
      story("US-1770", true, "[DEFERRED 2026-07-09] Needs a HELD migration, best done in a user-present session."),
    ]);
    expect(hits.map((h) => h.id)).toEqual(["US-1770"]);
  });

  it("treats a later NOT DONE segment as still blocked", () => {
    const hits = findUnresolvedDeferrals([
      story("US-B", true, "[DEFERRED 2026-01-01] x | NOT DONE (blocks passes): still broken"),
    ]);
    expect(hits.map((h) => h.id)).toEqual(["US-B"]);
  });

  it("clears only when a LATER segment carries the closing token", () => {
    expect(findUnresolvedDeferrals([
      story("US-C", true, "[DEFERRED 2026-01-01] x | DONE 2026-02-02: shipped it"),
    ])).toEqual([]);
  });
});
