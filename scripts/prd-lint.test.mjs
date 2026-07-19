// US-1612: vitest coverage for the prd.json linter (Node env — see
// vitest.scripts.config.mjs). Fixtures are inline prd objects.
import { describe, expect, it } from "vitest";
import { accumulationReminder, findCycles, findStaleHeldMigrations, findUnresolvedDeferrals, lintPrd, normalizeNextId, parseIdNum } from "./prd-lint.mjs";

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

  it("clears an un-deferral written in the SAME segment (the US-1399 shape)", () => {
    // Real false positive: US-1399s whole history is one segment ending in
    // "[COMPLETION 2026-07-03 - un-deferred]". Requiring a segment break, and
    // matching COMPLETED? rather than COMPLETION, reported a finished story as
    // blocked.
    const hits = findUnresolvedDeferrals([
      story("US-1399", true, "[DEFERRED 2026-06-27: needs a build-time fetch] [COMPLETION 2026-07-03 - un-deferred] graceful degradation is the contract now"),
    ]);
    expect(hits).toEqual([]);
  });

  it("still refuses to clear on a lowercase prose done in the same segment", () => {
    // The same-segment allowance must not reopen the original false negative.
    const hits = findUnresolvedDeferrals([
      story("US-Y", true, "[DEFERRED 2026-01-01] best done in a user-present session, work done by hand meanwhile"),
    ]);
    expect(hits.map((h) => h.id)).toEqual(["US-Y"]);
  });
});

// A HELD claim on a migration that is already pushed. Held means unpushed, so
// origin/main membership is proof the hold was released.
describe("findStaleHeldMigrations", () => {
  const story = (id, notes) => ({
    id,
    title: "t",
    description: "d",
    acceptanceCriteria: ["a"],
    passes: false,
    notes,
  });

  it("flags a HELD claim on a pushed migration", () => {
    const hits = findStaleHeldMigrations(
      [story("US-1421", "MIGRATION 00345 (HELD) adds a column")],
      new Set(["00345"]),
    );
    expect(hits).toEqual([{ id: "US-1421", migrations: ["00345"] }]);
  });

  it("ignores a genuinely pending migration", () => {
    // 00475/00476 are not on origin/main, so a hold on them is real.
    expect(
      findStaleHeldMigrations(
        [story("US-1897", "HELD MIGRATION: 00476 is committed locally")],
        new Set(["00345"]),
      ),
    ).toEqual([]);
  });

  it("is immune to its own correction text", () => {
    // The correction explains the fix by NAMING the genuinely-pending pair.
    // Keying on "pushed" rather than on version numbers means quoting them
    // cannot re-trigger the warning — reading numbers out of notes did exactly
    // that, reclassifying corrected stories as pending.
    const corrected = story(
      "US-1421",
      "MIGRATION 00345 (HELD) | ⚠ STALE HELD-MIGRATION CLAIM — the genuinely pending ones are 00475 and 00476.",
    );
    expect(findStaleHeldMigrations([corrected], new Set(["00345"]))).toEqual([]);
  });

  it("does not warn when the note also names a genuinely-unpushed migration", () => {
    // US-1968's real shape: the hold is on 00477 (unpushed), and the note CITES
    // 00113/00232 as the migrations that added the columns it builds on. Those
    // are long since pushed, so a naive check flagged a correct hold. A false
    // positive is worse than silence here — this check exists to stop a reader
    // trusting a stale freeze, so crying wolf on a real one defeats it.
    expect(
      findStaleHeldMigrations(
        [
          story(
            "US-1968",
            "builds on 00113 platform_fields and 00232 listing_origin. ⚠ HELD: depends on 00477.",
          ),
        ],
        new Set(["00113", "00232"]),
      ),
    ).toEqual([]);
  });

  it("still warns when EVERY migration named is already pushed", () => {
    // The complement of the case above: nothing is left that could be held, so
    // the HELD claim cannot be about anything real.
    expect(
      findStaleHeldMigrations(
        [story("US-Z", "HELD: 00113 and 00232 are committed locally, do not push")],
        new Set(["00113", "00232"]),
      ),
    ).toEqual([{ id: "US-Z", migrations: ["00113", "00232"] }]);
  });

  it("matches five-digit ids", () => {
    // An earlier hand-written sweep used 00[3-4][0-9]{3} — six digits — so it
    // could never match 00345 and reported zero, which reads as clean.
    expect(
      findStaleHeldMigrations([story("US-X", "HELD 00345")], new Set(["00345"])).length,
    ).toBe(1);
  });

  it("skips stories with no HELD marker at all", () => {
    expect(findStaleHeldMigrations([story("US-Y", "migration 00345 shipped")], new Set(["00345"]))).toEqual([]);
  });
});

// The CLI must actually execute. Its entry guard compared import.meta.url to
// `file://` + a raw argv path, which is only accidentally correct on POSIX and
// never matches on Windows — so `node scripts/prd-lint.mjs` exited 0 having run
// nothing, on every Windows invocation including the verify:web lane.
describe("prd-lint CLI entry", () => {
  it("uses a URL-to-URL comparison, not string concatenation", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("scripts/prd-lint.mjs", "utf8");
    expect(src).not.toContain("`file://${process.argv[1]}`");
    expect(src).toContain("pathToFileURL(process.argv[1]).href");
  });
});

describe("US-2088: planning fields only bind unfinished stories", () => {
  const bare = (over = {}) => ({ id: "US-1", title: "t", passes: false, ...over });

  it("still requires description + acceptanceCriteria on passes:false", () => {
    const r = lintPrd({ prd: prd([bare()]) });
    expect(r.errors.some((e) => e.includes('missing required field "description"'))).toBe(true);
    expect(r.errors.some((e) => e.includes('missing required field "acceptanceCriteria"'))).toBe(true);
  });
  it("exempts a passes:true record — a finished story cannot be planned", () => {
    const r = lintPrd({ prd: prd([bare({ passes: true })]) });
    expect(r.errors.some((e) => e.includes("missing required field"))).toBe(false);
  });
  it("still requires id/title/passes even on a record", () => {
    const r = lintPrd({ prd: prd([{ id: "US-1", passes: true }]) });
    expect(r.errors.some((e) => e.includes('missing required field "title"'))).toBe(true);
  });
  it("still type-checks the fields a record DOES carry", () => {
    const r = lintPrd({ prd: prd([bare({ passes: true, acceptanceCriteria: "not an array" })]) });
    expect(r.errors.some((e) => e.includes("acceptanceCriteria must be an array"))).toBe(true);
  });
});

describe("US-2088: normalizeNextId", () => {
  it("accepts a bare integer", () => {
    expect(normalizeNextId(2088)).toBe(2088);
  });
  it("accepts the US-<n> string form", () => {
    expect(normalizeNextId("US-2088")).toBe(2088);
  });
  it("rejects anything else", () => {
    for (const v of ["2088", "US-", "US-abc", 20.5, null, undefined, {}]) {
      expect(normalizeNextId(v)).toBeNull();
    }
  });
  it("enforces the > max-id invariant in BOTH forms", () => {
    const s = story({ id: "US-50" });
    expect(lintPrd({ prd: prd([s], 10) }).errors.some((e) => e.includes("nextId"))).toBe(true);
    expect(lintPrd({ prd: prd([s], "US-10") }).errors.some((e) => e.includes("nextId"))).toBe(true);
    expect(lintPrd({ prd: prd([s], "US-51") }).errors.some((e) => e.includes("nextId"))).toBe(false);
  });
});
