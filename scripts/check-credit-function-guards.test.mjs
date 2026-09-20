import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { psqlTarget } from "./lib/psql-target.mjs";

// US-3445. This script asserts a money invariant against the CATALOG, and it
// could only be run against a docker container until now. Two things are worth
// pinning: that it takes a --dsn like every other db-lane check, and that it
// does NOT inherit psqlTarget's `-tA`.

const SRC = readFileSync("scripts/check-credit-function-guards.mjs", "utf8");

describe("check-credit-function-guards is runnable without docker (US-3445)", () => {
  it("resolves its target through psqlTarget rather than docker ps", () => {
    expect(SRC).toContain("psqlTarget");
    // The old path shelled out to `docker ps --filter name=supabase_db_` and
    // threw when it found nothing. Nothing else could reach the database.
    expect(SRC).not.toContain("name=supabase_db_");
    expect(SRC).not.toContain("dbContainer");
  });

  it("reports an unreachable database as a reach failure, not a verdict", () => {
    // exit 2 is "could not ask", exit 1 is "asked and the answer is bad". A
    // script that conflates them turns an unplugged database into a clean bill.
    expect(SRC).toContain("looksUnreachable");
    expect(SRC).toContain("process.exit(2)");
  });

  it("strips -tA, because it parses psql's ALIGNED output", () => {
    // psqlTarget hands back `-tA` for the fourteen callers that want
    // tuples-only unaligned rows. This one cuts each section at its "(n rows)"
    // line, which `-tA` suppresses along with the header. The first port kept
    // the flag and died with "section 'selfcheck' has no (n rows) line".
    expect(SRC).toContain('filter((a) => a !== "-tA")');
    // And the assumption behind that line: psqlTarget really does supply it.
    expect(psqlTarget(["--dsn", "postgresql://x"]).argv).toContain("-tA");
    expect(psqlTarget([]).argv).toContain("-tA");
  });

  it("still has its own self-check, which is what makes a clean run mean something", () => {
    // Two probe functions, one guarded and one not, created in the same
    // transaction. A detector that always says clean looks exactly like a clean
    // codebase, and this repo has shipped a guard that could never fire twice.
    expect(SRC).toContain("gt_credit_probe_guarded");
    expect(SRC).toContain("gt_credit_probe_open");
    expect(SRC).toContain("rollback");
  });
});
