// US-2663: the RPC-body checker's decision functions, and its wiring.
//
// The checker itself needs Docker and a live stack, so it is exercised for real
// by the db lane. What is unit-testable here is the part that took three
// attempts to get right — building a CALL that actually reaches the body — plus
// the wiring, because a gate that runs nowhere is the failure this whole story
// is about.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { argsFor, calledRpcNames, literalFor } from "./check-rpc-column-refs.mjs";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("building a call that reaches the body", () => {
  it("never produces a NULL for a type it knows", () => {
    // ⚠ THE WHOLE POINT. The first version called with no arguments and reached
    // almost nothing; the second passed NULLs and was stopped by the functions'
    // own argument guards ("start must precede end"). Both leave the body
    // unexecuted, and an unexecuted body cannot reveal a missing column — so
    // both reported a clean sweep against a schema with a known break in it.
    for (const t of [
      "timestamp with time zone", "date", "uuid", "integer", "bigint",
      "numeric", "boolean", "jsonb", "text", "character varying", "interval",
    ]) {
      expect(literalFor(t, 0), `${t} must get a real value`).not.toMatch(/^null::/);
    }
  });

  it("backdates the FIRST timestamp so start < end holds", () => {
    // These functions share a (p_start, p_end) shape and raise 22023 when the
    // window is inverted or zero-length. Two now() values fail that check.
    const args = argsFor("p_start timestamp with time zone, p_end timestamp with time zone");
    const [first, second] = args.split(", ");
    expect(first).toContain("interval '30 days'");
    expect(second.trim()).toBe("now()");
  });

  it("handles a signature with no arguments", () => {
    expect(argsFor("")).toBe("");
  });

  it("strips argument NAMES and keeps the type", () => {
    expect(argsFor("p_user_id uuid")).toMatch(/::uuid/);
    expect(argsFor("uuid")).toMatch(/::uuid/);
  });

  it("passes an empty array rather than NULL for array types", () => {
    expect(argsFor("p_ids uuid[]")).toBe("'{}'::uuid[]");
  });

  it("finds the RPCs the edge actually calls, and excludes tests", () => {
    const names = calledRpcNames();
    expect(names.length).toBeGreaterThan(30);
    expect(names).toContain("revenue_dashboard");
    // Sorted + unique, so the psql IN-list is stable run to run.
    expect([...new Set(names)].sort()).toEqual(names);
  });
});

describe("the checker is wired where it can run", () => {
  it("runs in the db lane and in db-migrations CI", () => {
    // It needs a live Postgres, so it belongs to the db lane rather than the
    // web one — and the db lane is exactly the gate that was green while
    // revenue_dashboard was broken.
    expect(read("scripts/verify.mjs")).toContain("scripts/check-rpc-column-refs.mjs");
    expect(read(".github/workflows/db-migrations.yml")).toContain(
      "scripts/check-rpc-column-refs.mjs",
    );
  });

  it("gates rather than advising", () => {
    // Deliberately unlike the US-2403 denied-RPC check beside it, which is
    // continue-on-error because the image is vulnerable today. This one passes
    // today, so it gates; an advisory check that has never failed teaches
    // nobody anything.
    const wf = read(".github/workflows/db-migrations.yml");
    const step = wf.slice(wf.indexOf("RPC bodies resolve"));
    const nextStep = step.indexOf("- name:", 1);
    // Comments stripped first: the US-2403 step's own explanation ends with
    // "Drop continue-on-error the moment the check goes green", and a raw scan
    // of the intervening text matched that prose rather than any YAML key.
    const body = step
      .slice(0, nextStep === -1 ? undefined : nextStep)
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(body).not.toContain("continue-on-error");
  });

  it("rolls back every call it makes", () => {
    // The checker CALLS mutating functions on purpose — a broken column
    // reference in a write path is worse, not better. The rollback is the only
    // thing making that safe, so it is pinned.
    const src = read("scripts/check-rpc-column-refs.mjs");
    expect(src).toContain("statement_timeout");
    // Order, not count. The generated SQL is one template per function, so
    // counting anchored lines measured the TEMPLATE (one `begin;` at line start,
    // one `rollback;` that is not, because it closes the template literal) and
    // said 1 vs 0 about code that is correct.
    const tpl = src.slice(src.indexOf("const sql = rows.map"));
    const begin = tpl.indexOf("begin;");
    const call = tpl.indexOf("perform public.");
    const rollback = tpl.indexOf("rollback;");
    expect(begin, "the template must open a transaction").toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(begin);
    expect(rollback, "every call must be rolled back").toBeGreaterThan(call);
  });

  it("reads stderr, where RAISE NOTICE actually goes", () => {
    // An earlier version read only stdout and reported "none found" from the
    // same run that printed the finding to the terminal.
    expect(read("scripts/check-rpc-column-refs.mjs")).toContain("res.stderr");
  });
});
