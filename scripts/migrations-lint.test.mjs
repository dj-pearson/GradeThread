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
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  duplicateVersions,
  gapReport,
  GRANDFATHERED_UNGUARDED_POLICIES,
  GRANDFATHERED_UNGUARDED_TRIGGERS,
  IDEMPOTENT_GRANDFATHERED_THROUGH,
  ignoreRulesNamingMigrations,
  ineffectiveRevokes,
  INEFFECTIVE_REVOKE_GRANDFATHERED,
  KNOWN_GAPS,
  shapeFailures,
  SIX_DIGIT_BY_DESIGN,
  unguardedCreates,
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

describe("a revoke that revokes nothing (US-2666)", () => {
  // The rule exists because this failure is invisible everywhere else: the SQL
  // is valid, the REVOKE succeeds, psql prints REVOKE, and the migration
  // applies green while the function stays callable by the public anon key.
  const dir = (files) => ({
    names: Object.keys(files),
    read: (f) => files[f],
  });

  it("flags a revoke naming only anon", () => {
    const d = dir({
      "00900_x.sql": "revoke all on function public.f(uuid) from anon;",
    });
    expect(ineffectiveRevokes(d.names, d.read).map((h) => h.key)).toEqual(["00900_x.sql:f"]);
  });

  it("accepts PUBLIC in the same statement — the working form", () => {
    // 00216_credit_ledger_admin.sql:143 is the model this points people at.
    const d = dir({
      "00900_x.sql": "REVOKE ALL ON FUNCTION public.f(uuid, integer)\n  FROM PUBLIC, anon, authenticated;",
    });
    expect(ineffectiveRevokes(d.names, d.read)).toEqual([]);
  });

  it("accepts PUBLIC in a SEPARATE statement for the same function", () => {
    // The grouping case, and the reason the first version of this rule reported
    // 14 where there are 6. Splitting the roles across statements is correct.
    const d = dir({
      "00900_x.sql": [
        "revoke all on function public.f(uuid) from public;",
        "revoke all on function public.f(uuid) from anon;",
        "revoke all on function public.f(uuid) from authenticated;",
      ].join("\n"),
    });
    expect(ineffectiveRevokes(d.names, d.read)).toEqual([]);
  });

  it("does not let one function's PUBLIC revoke excuse another's", () => {
    const d = dir({
      "00900_x.sql": [
        "revoke all on function public.safe(uuid) from public, anon;",
        "revoke all on function public.leaky(uuid) from anon;",
      ].join("\n"),
    });
    expect(ineffectiveRevokes(d.names, d.read).map((h) => h.key)).toEqual(["00900_x.sql:leaky"]);
  });

  it("grandfathers only the six that already shipped, by file AND function", () => {
    // Applied migrations are immutable, so these cannot be edited — they are
    // fixed forward. Keying on file+function means a NEW no-op added to one of
    // those same files still fails.
    expect(INEFFECTIVE_REVOKE_GRANDFATHERED.size).toBe(6);
    for (const key of INEFFECTIVE_REVOKE_GRANDFATHERED.keys()) {
      expect(key, `${key} must be file.sql:function`).toMatch(/^\d{5}_[a-z0-9_]+\.sql:[a-z0-9_]+$/);
    }
    expect(INEFFECTIVE_REVOKE_GRANDFATHERED.has("00099_snap_quota.sql:reserve_snap")).toBe(true);
  });

  it("every grandfathered entry says what it leaves reachable", () => {
    for (const [key, why] of INEFFECTIVE_REVOKE_GRANDFATHERED) {
      expect(why.length, `${key} needs a reason`).toBeGreaterThan(10);
    }
  });

  it("the real directory is clean apart from those six", () => {
    // Deliberately an end-to-end assertion over the ACTUAL migrations, unlike
    // the synthetic cases above. It is what turns the list into a ratchet: a
    // seventh no-op fails here even if nobody runs the lint by hand.
    const names = readdirSync(resolve(process.cwd(), "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"));
    const hits = ineffectiveRevokes(names, (f) => read(`supabase/migrations/${f}`));
    expect(hits.map((h) => h.key).sort()).toEqual(
      [...INEFFECTIVE_REVOKE_GRANDFATHERED.keys()].sort(),
    );
  });
});

describe("safe to run twice (US-2837)", () => {
  const dir = (files) => ({ names: Object.keys(files), read: (f) => files[f] });
  const kinds = (files) => unguardedCreates(dir(files).names, dir(files).read)
    .map((h) => `${h.kind}:${h.name}`);

  it("flags a CREATE FUNCTION that is not CREATE OR REPLACE", () => {
    // The 00609 case. A second run raises "already exists with same argument
    // types" and aborts every statement after it.
    expect(kinds({ "00900_x.sql": "CREATE FUNCTION public.f(uuid) RETURNS int" })).toEqual([
      "function:f",
    ]);
  });

  it("accepts CREATE OR REPLACE FUNCTION", () => {
    expect(kinds({ "00900_x.sql": "CREATE OR REPLACE FUNCTION public.f(uuid)" })).toEqual([]);
  });

  it("accepts a DROP of an OLD signature alongside OR REPLACE — the 00609 fix", () => {
    // Both halves are load-bearing and they are not in tension. The DROP removes
    // the 6-arg signature so an existing call is never ambiguous; the OR REPLACE
    // is what makes the SECOND run a no-op, when the drop matches nothing.
    expect(
      kinds({
        "00900_x.sql": [
          "DROP FUNCTION IF EXISTS public.f(uuid, integer);",
          "CREATE OR REPLACE FUNCTION public.f(uuid, integer, text)",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("flags a CREATE TRIGGER with no DROP, and accepts one with", () => {
    expect(kinds({ "00900_x.sql": "create trigger t_x before insert on y" })).toEqual([
      "trigger:t_x",
    ]);
    expect(
      kinds({
        "00900_x.sql": "drop trigger if exists t_x on y;\ncreate trigger t_x before insert on y",
      }),
    ).toEqual([]);
  });

  it("accepts CREATE OR REPLACE TRIGGER (PG14+)", () => {
    expect(kinds({ "00900_x.sql": "create or replace trigger t_x before insert on y" })).toEqual([]);
  });

  it("flags a CREATE POLICY with no DROP, and accepts the pg_policies guard", () => {
    // There is no CREATE OR REPLACE POLICY, so the existence guard is a real
    // alternative rather than an escape hatch — but it has to name THIS policy.
    expect(kinds({ '00900_x.sql': 'create policy "p one" on t for select' })).toEqual([
      "policy:p one",
    ]);
    expect(
      kinds({
        "00900_x.sql":
          "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'p one')\n" +
          '  THEN CREATE POLICY "p one" ON t FOR SELECT USING (true); END IF; END $$;',
      }),
    ).toEqual([]);
  });

  it("a COMMENT mentioning the drop does not satisfy the rule", () => {
    // Mode 7 of guards-that-do-not-guard: the guard fired on the documentation
    // written about it. Comments are stripped before matching for this reason,
    // and the sabotage run replaced a real DROP with exactly this comment.
    expect(
      kinds({
        "00900_x.sql": "-- removed: drop trigger if exists t_x\ncreate trigger t_x before insert on y",
      }),
    ).toEqual(["trigger:t_x"]);
  });

  it("compares the threshold LEXICALLY, so a 6-digit file stays grandfathered", () => {
    // 000375 sorts between 00037 and 00038 — that is the whole point of
    // SIX_DIGIT_BY_DESIGN. Parsed as an integer it reads 375, which is past the
    // threshold, and the first cut of this rule declared two of the oldest
    // migrations in the repo to be new violations because of it.
    expect(typeof IDEMPOTENT_GRANDFATHERED_THROUGH).toBe("string");
    expect("000375" < IDEMPOTENT_GRANDFATHERED_THROUGH).toBe(true);
    expect(Number.parseInt("000375", 10) < Number.parseInt(IDEMPOTENT_GRANDFATHERED_THROUGH, 10))
      .toBe(false);
  });

  it("the real directory has ZERO violations above the threshold", () => {
    // The ratchet, asserted end to end over the ACTUAL migrations. Every one of
    // the files from 00292 to today already complies; this is what stops that
    // drifting back.
    const names = readdirSync(resolve(process.cwd(), "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"));
    const hits = unguardedCreates(names, (f) => read(`supabase/migrations/${f}`));
    const above = hits.filter((h) => h.version > IDEMPOTENT_GRANDFATHERED_THROUGH);
    expect(above.map((h) => `${h.file}:${h.kind}:${h.name}`)).toEqual([]);
  });

  it("no CREATE FUNCTION anywhere lacks OR REPLACE — zero, not grandfathered", () => {
    // 00609 was the only one in 658 files, and it is fixed, so the correct
    // count is zero at EVERY version. There is deliberately no allowlist.
    const names = readdirSync(resolve(process.cwd(), "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"));
    const fns = unguardedCreates(names, (f) => read(`supabase/migrations/${f}`))
      .filter((h) => h.kind === "function");
    expect(fns.map((h) => `${h.file}:${h.name}`)).toEqual([]);
  });

  it("the grandfathered counts match, so the historical set can only shrink", () => {
    const names = readdirSync(resolve(process.cwd(), "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"));
    const hits = unguardedCreates(names, (f) => read(`supabase/migrations/${f}`))
      .filter((h) => h.version <= IDEMPOTENT_GRANDFATHERED_THROUGH);
    expect(hits.filter((h) => h.kind === "trigger").length).toBe(GRANDFATHERED_UNGUARDED_TRIGGERS);
    expect(hits.filter((h) => h.kind === "policy").length).toBe(GRANDFATHERED_UNGUARDED_POLICIES);
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
