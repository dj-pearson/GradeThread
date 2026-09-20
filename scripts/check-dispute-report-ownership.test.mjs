// US-2670: the runner around the dispute-ownership fixture.
//
// The fixture itself needs a Postgres and is exercised by running it. What can
// be checked without one is the part that went wrong while writing it: psql
// prints RAISE NOTICE on STDERR, so a runner reading stdout alone reports
// "nothing was proved" against a database that had just proved it. These cases
// pin the wiring, not the policy.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = "scripts/check-dispute-report-ownership.mjs";

function run(args) {
  try {
    return { code: 0, out: execFileSync("node", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" }) };
  } catch (err) {
    return { code: err.status ?? 1, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
  }
}

describe("check-dispute-report-ownership.mjs", () => {
  it("reports the DSN it could not reach, not a container name", () => {
    const { code, out } = run(["--dsn", "postgresql://postgres@127.0.0.1:1/postgres"]);
    expect(code).toBe(2);
    expect(out).toContain("postgresql://postgres@127.0.0.1:1/postgres");
    expect(out).not.toContain("docker start");
  });

  it("still names the container when no DSN is given", () => {
    const { code, out } = run(["--container", "no_such_container_for_this_test"]);
    expect(code).toBe(2);
    expect(out).toContain("no_such_container_for_this_test");
    expect(out).toContain("--dsn");
  });

  it("reads both streams, because the answer arrives on stderr", () => {
    // The defect this pins: psql RAISE NOTICE goes to stderr. A runner using
    // execFileSync (stdout only) saw none of the RESULT lines and reported a
    // passing database as unproved.
    const src = readFileSync(resolve(ROOT, SCRIPT), "utf8");
    expect(src).toMatch(/spawnSync/);
    expect(src).toMatch(/run\.stdout[\s\S]{0,60}run\.stderr/);
  });

  it("asserts BOTH directions, so a deny-everything policy cannot pass", () => {
    // Measured: a `with check (false)` on both policies refuses the foreign
    // insert AND the seller's own. Checking only the first would call that a
    // pass while every real dispute was broken.
    const src = readFileSync(resolve(ROOT, SCRIPT), "utf8");
    expect(src).toMatch(/foreign_insert/);
    expect(src).toMatch(/own_insert/);
    expect(src).toMatch(/no longer dispute their OWN/);
  });

  it("the fixture writes nothing", () => {
    // It seeds two sellers and a grade report. The rollback is what makes it
    // safe to point at any database, including one somebody cares about.
    const sql = readFileSync(resolve(ROOT, "scripts/fixtures/dispute-report-ownership.sql"), "utf8");
    expect(sql).toMatch(/^begin;/m);
    expect(sql.trimEnd().endsWith("rollback;")).toBe(true);
    expect(sql).not.toMatch(/^\s*commit;/mi);
  });
});
