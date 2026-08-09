// US-2444 AC5 — the migrations lint's decision functions.
//
// The four rules are pure over a filename list, so they are tested against
// synthetic directories rather than the real one. That matters: a test asserting
// "the repo passes today" goes green forever the moment the repo is clean, and
// says nothing about whether the rules would FIRE. Each case below is a
// directory that must be rejected.
//
// The one case that cannot be synthesised is the git half (ignoredPaths), which
// needs a real repo — so it is covered by the wiring assertions plus the
// end-to-end run in verify/CI.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  duplicateVersions,
  gapReport,
  ignoreRulesNamingMigrations,
  KNOWN_GAPS,
  shapeFailures,
  SIX_DIGIT_BY_DESIGN,
} from "./migrations-lint.mjs";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("ignore rules that can reach a migration", () => {
  it("catches a rule naming a file that does not exist yet — the 00122 case", () => {
    // No scan of the directory could find this, because there is nothing to
    // find. That is the entire reason the ignore FILES are read separately.
    const hits = ignoreRulesNamingMigrations(
      ["node_modules/", "supabase/migrations/00122_verified_storefront_listings.sql", "dist/"]
        .join("\n"),
    );
    expect(hits.map((h) => h.line)).toEqual([2]);
  });

  it("ignores comments and unrelated lines", () => {
    const hits = ignoreRulesNamingMigrations(
      ["# supabase/migrations/ is never ignored", "supabase/.temp/", "coverage/"].join("\n"),
    );
    expect(hits).toEqual([]);
  });

  it("treats ANY rule in a nested supabase/migrations/.gitignore as a hit", () => {
    // A rule there needs no path prefix, so matching on the literal prefix would
    // miss every one of them.
    expect(ignoreRulesNamingMigrations("*.sql\n", { nested: true })).toHaveLength(1);
    expect(ignoreRulesNamingMigrations("*.sql\n", { nested: false })).toEqual([]);
  });
});

describe("filename shape", () => {
  it("accepts the normal form", () => {
    expect(shapeFailures([...SIX_DIGIT_BY_DESIGN, "00563_thing.sql"])).toEqual([]);
  });

  it("rejects a name the CLI cannot derive a version from", () => {
    const bad = shapeFailures([...SIX_DIGIT_BY_DESIGN, "fix-the-thing.sql"]);
    expect(bad).toEqual([{ file: "fix-the-thing.sql", kind: "malformed" }]);
  });

  it("rejects a NEW 6-digit prefix — it means the collision recurred", () => {
    const bad = shapeFailures([...SIX_DIGIT_BY_DESIGN, "005635_thing.sql"]);
    expect(bad).toEqual([{ file: "005635_thing.sql", kind: "unpinned-six-digit" }]);
  });

  it("rejects a pinned 6-digit file that has vanished", () => {
    // The pin may only shrink deliberately: these three exist to split a
    // duplicate that broke `supabase db start`, so one disappearing quietly is
    // the collision coming back.
    const bad = shapeFailures(["00563_thing.sql"]);
    expect(bad.map((b) => b.kind)).toEqual([
      "pinned-but-absent",
      "pinned-but-absent",
      "pinned-but-absent",
    ]);
  });

  it("allows the .BLOCKED escape hatch", () => {
    expect(shapeFailures([...SIX_DIGIT_BY_DESIGN, "00527_revoke.sql.BLOCKED"])).toEqual([]);
  });
});

describe("duplicate versions", () => {
  it("catches two files claiming one schema_migrations key", () => {
    const dup = duplicateVersions(["00035_a.sql", "00035_b.sql", "00036_c.sql"]);
    expect(dup).toEqual([["00035", ["00035_a.sql", "00035_b.sql"]]]);
  });

  it("does NOT flag the 6-digit split as a duplicate — that is the fix", () => {
    expect(duplicateVersions(["00035_a.sql", "000355_b.sql"])).toEqual([]);
  });
});

describe("sequence gaps", () => {
  it("reports a gap that is not annotated", () => {
    const r = gapReport(["00001_a.sql", "00003_c.sql"]);
    expect(r.gaps).toEqual(["00002"]);
    expect(r.unexplained).toEqual(["00002"]);
  });

  it("stays quiet about an annotated one", () => {
    const r = gapReport(["00010_a.sql", "00012_c.sql"]);
    expect(r.gaps).toEqual(["00011"]);
    expect(r.unexplained).toEqual([]);
  });

  it("fails when an annotated gap gets filled — the list may only shrink", () => {
    // Otherwise a baseline written once becomes permanent, and the entry for a
    // resolved hole keeps telling the next reader it is still open.
    const all = [...KNOWN_GAPS.keys()].map((v) => `${v}_now_exists.sql`);
    const r = gapReport(["00001_a.sql", ...all, "00563_z.sql"]);
    expect(r.filled.sort()).toEqual([...KNOWN_GAPS.keys()].sort());
  });

  it("counts the .BLOCKED file as absent — it is held, not applied", () => {
    // gapReport is fed *.sql only, so 00527 reads as a gap and KNOWN_GAPS
    // explains why. Counting it as present would hide a genuinely missing 00527.
    expect(KNOWN_GAPS.get("00527")).toMatch(/BLOCKED/);
  });
});

describe("every annotated gap says why", () => {
  it("has a non-trivial reason per entry", () => {
    // A baseline of bare numbers is a list nobody can shrink, because the next
    // reader cannot tell which are holes and which are skipped numbers.
    for (const [version, reason] of KNOWN_GAPS) {
      expect(reason.length, `KNOWN_GAPS[${version}] needs a reason`).toBeGreaterThan(20);
    }
  });
});

describe("the lint is actually wired", () => {
  it("runs in verify and in CI", () => {
    // US-2402's lesson: a gate that lives only in the pre-push hook is one
    // `--no-verify` away from not existing, and the hook was stricter than the
    // pipeline it claims to mirror.
    expect(read("scripts/verify.mjs")).toContain("scripts/migrations-lint.mjs");
    expect(read(".github/workflows/ci.yml")).toContain("scripts/migrations-lint.mjs");
  });

  it("no migration path is named in .gitignore (AC4)", () => {
    expect(ignoreRulesNamingMigrations(read(".gitignore"))).toEqual([]);
  });
});
