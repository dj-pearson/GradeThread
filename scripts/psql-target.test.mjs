// scripts/lib/psql-target.mjs -- the two traps that cost a debugging round each.
//
// Both are invisible at review time and both produce a confident wrong answer
// rather than an error, which is why they get cases rather than comments.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { psqlTarget, runFixture } from "./lib/psql-target.mjs";

const ROOT = resolve(import.meta.dirname, "..");

describe("psqlTarget", () => {
  it("prefers a DSN and reports it, rather than advising a container restart", () => {
    const t = psqlTarget(["--dsn", "postgresql://x@127.0.0.1:1/y"], {});
    expect(t.cmd).toBe("psql");
    expect(t.how).toContain("postgresql://x@127.0.0.1:1/y");
    expect(t.hint).not.toContain("docker start");
  });

  it("falls back to the container, and its hint offers the DSN form", () => {
    const t = psqlTarget([], {});
    expect(t.cmd).toBe("docker");
    expect(t.how).toContain("supabase_db_gradethread");
    expect(t.hint).toContain("--dsn");
  });

  it("takes the container name from the flag", () => {
    const t = psqlTarget(["--container", "some_other_db"], {});
    expect(t.how).toContain("some_other_db");
  });
});

describe("runFixture includes", () => {
  const dir = mkdtempSync(join(tmpdir(), "psql-target-"));

  it("splices an included file without eating its dollar quotes", () => {
    // THE TRAP. `$$` in a JavaScript replacement STRING is the escape for a
    // literal `$`, so a plain replaceAll turns every dollar-quoted plpgsql
    // block into `do $ ... $` and psql answers "syntax error at or near $".
    // Measured on migration 00806.
    const inc = join(dir, "inc.sql");
    writeFileSync(inc, "do $$ begin raise notice 'hi'; end $$;\n");
    const fixture = join(dir, "fixture.sql");
    writeFileSync(fixture, "begin;\n-- @@X@@\nrollback;\n");
    // `cat` stands in for psql: it echoes exactly what it was handed.
    const { ok, out } = runFixture({ cmd: "cat", argv: [] }, fixture, {
      includes: { "-- @@X@@": inc },
    });
    expect(ok).toBe(true);
    expect(out).toContain("do $$ begin");
    expect(out).not.toContain("do $ begin");
  });

  it("refuses when the placeholder is not there, rather than running a fixture that proves nothing", () => {
    const inc = join(dir, "inc2.sql");
    writeFileSync(inc, "select 1;\n");
    const fixture = join(dir, "fixture2.sql");
    writeFileSync(fixture, "select 2;\n");
    const { ok, out } = runFixture({ cmd: "cat", argv: [] }, fixture, {
      includes: { "-- @@MISSING@@": inc },
    });
    expect(ok).toBe(false);
    expect(out).toContain("no placeholder");
  });

  it("reads stderr as well as stdout, because psql prints notices there", () => {
    // A runner on execFileSync (stdout only) reported "nothing was proved"
    // against a database that had just proved it.
    const fixture = join(dir, "fixture3.sql");
    writeFileSync(fixture, "ignored\n");
    const { ok, out } = runFixture(
      { cmd: "sh", argv: ["-c", "cat >/dev/null; echo NOTICE 1>&2"] },
      fixture,
    );
    expect(ok).toBe(true);
    expect(out).toContain("NOTICE");
  });
});

describe("the fixtures write nothing", () => {
  it.each([
    "scripts/fixtures/dispute-report-ownership.sql",
    "scripts/fixtures/whole-dollar-price-repair.sql",
  ])("%s opens a transaction and rolls back", async (rel) => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(resolve(ROOT, rel), "utf8");
    expect(sql).toMatch(/^begin;/m);
    expect(sql.trimEnd().endsWith("rollback;")).toBe(true);
    expect(sql).not.toMatch(/^\s*commit;/mi);
  });
});

describe("looksUnreachable", () => {
  it("is false for a clean run", async () => {
    const { looksUnreachable } = await import("./lib/psql-target.mjs");
    expect(looksUnreachable("anything", 0)).toBe(false);
  });

  it("is true for psql's connection refusal", async () => {
    // THE REGRESSION THIS PINS. psql prints this on stderr, so an
    // "ok means it printed something" rule called an unreachable server a
    // successful run and the caller reported a fixture problem instead.
    const { looksUnreachable } = await import("./lib/psql-target.mjs");
    expect(
      looksUnreachable(
        'psql: error: connection to server at "127.0.0.1", port 1 failed: Connection refused',
        2,
      ),
    ).toBe(true);
  });

  it("is true for a missing docker container", async () => {
    const { looksUnreachable } = await import("./lib/psql-target.mjs");
    expect(looksUnreachable("Error response from daemon: No such container: x", 1)).toBe(true);
  });

  it("is FALSE for a fixture that ran and failed an assertion", async () => {
    // The other direction, and the one that matters more: a database that
    // answered must not be reported as unreachable, or a real failure reads as
    // a connection problem and nobody looks at the SQL.
    const { looksUnreachable } = await import("./lib/psql-target.mjs");
    expect(looksUnreachable("ERROR:  null value in column violates not-null", 3)).toBe(false);
  });
});
