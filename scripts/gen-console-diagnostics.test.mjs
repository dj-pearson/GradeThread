// The generated console diagnostics must describe the source it was generated
// from, and must still be console-safe.
//
// WHY THIS EXISTS. The generator's header hardcoded "sections are marked `§1` …
// `§13`" while the source had grown to §27. An operator following that
// instruction runs thirteen sections and stops, believing they are done — and
// the fourteen they skip are the ones most of the open backlog is blocked on
// (US-2347, US-2288, US-2289, US-2117, US-2444, US-2403, US-2286, US-2606,
// US-2304, US-2610). A stale number in an instruction is worse than no number,
// because it reads as completeness.
//
// The range is derived now. This is what stops the derivation quietly breaking
// and going back to a claim nobody checks.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderConsoleSql, sectionNumbers } from "./gen-console-diagnostics.mjs";

const SRC = "scripts/prod-diagnostics.sql";
const OUT = "scripts/prod-diagnostics-console.sql";
const read = (p) => readFileSync(p, "utf8");

describe("gen-console-diagnostics", () => {
  it("finds the source's sections, so the range cannot be derived from nothing", () => {
    // Guarding the guard: if the index format changes and the scan returns
    // nothing, the generator throws rather than emitting a header with no range
    // — but this is what notices the format drifted at all.
    const nums = sectionNumbers(read(SRC));
    expect(nums.length).toBeGreaterThan(10);
    expect(nums[0]).toBe(1);
  });

  it("the console copy's advertised range matches the source", () => {
    const nums = sectionNumbers(read(SRC));
    const out = read(OUT);
    const stated = out.match(/there are\s*\n--\s*(\d+), marked `§(\d+)` … `§(\d+)`/);
    expect(stated, "the console header no longer states a section range").toBeTruthy();
    expect(Number(stated[1])).toBe(nums.length);
    expect(Number(stated[2])).toBe(nums[0]);
    expect(Number(stated[3])).toBe(nums[nums.length - 1]);
  });

  it("the checked-in copy is what the generator produces right now", () => {
    // The file is generated and committed, so an edit to the source that nobody
    // regenerated leaves the two describing different things — which is the
    // whole failure mode, one level up.
    //
    // COMPARED, NOT REGENERATED. This used to shell out to the generator, which
    // REWROTE the file — repairing it for the two cases below, so neither could
    // ever see a bad one. renderConsoleSql is pure, so asking "is the committed
    // file current?" no longer produces a current file as a side effect.
    expect(
      read(OUT),
      "run `node scripts/gen-console-diagnostics.mjs` and commit the result",
    ).toBe(renderConsoleSql(read(SRC)));
  });

  it("is still console-safe: no psql meta-commands survive", () => {
    // The original reason this generator exists. A console forwards a backslash
    // line to the server, which rejects it with 42601 at the FIRST one, so a
    // single survivor makes the whole file unusable in the Supabase editor.
    const offenders = read(OUT)
      .split("\n")
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /^\\/.test(l));
    expect(offenders, `meta-commands survived: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it("is still read-only", () => {
    // Stated in both headers, so it had better be true. Comments are stripped
    // first: several sections legitimately DESCRIBE a write they do not perform.
    const sql = read(OUT)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    for (const verb of ["insert into", "update ", "delete from", "drop ", "alter ", "create "]) {
      expect(
        new RegExp(`(^|\\s)${verb}`, "i").test(sql),
        `${verb.trim()} appears outside a comment — this file is advertised as read-only`,
      ).toBe(false);
    }
  });
});
