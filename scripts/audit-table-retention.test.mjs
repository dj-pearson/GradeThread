// US-2644: the statement parser, which is the whole correctness of the tool.
//
// TWO SCANS BEFORE THIS ONE WERE WRONG, BOTH IN THE SAME DIRECTION — they
// reported a table as never deleted from when it is. That direction is the
// dangerous one: it invites building a retention sweep that already exists, and
// on a PII-bearing table it turns into a privacy finding that is not real.
//
//   1. A fixed 300-character window with a lookahead cut the chain short, so
//      `radar_scan_events` (deleted in a helper) read as unswept.
//   2. Requiring EMPTY parens, `/\.delete\(\s*\)/`, missed
//      `.delete({ count: "exact" })` in purgeExpiredGradingPii, so
//      `submission_images` — the grading-photo PII table, the one the Privacy
//      Policy names explicitly — read as unswept.
//
// Both were caught only by checking the tool against deletes already read by
// hand. So the fixtures below are the real shapes from this repo, not invented
// ones, and the over-reach case matters just as much: a window that runs too
// far attributes a neighbour's delete to the wrong table, which is the same lie
// pointing the other way.

import { describe, expect, it } from "vitest";
import { statementAt, deletedTables, declaredTables } from "./audit-table-retention.mjs";

const at = (src, table) => statementAt(src, src.indexOf(`.from("${table}")`));

describe("US-2644: a supabase chain is read to its semicolon, not a guessed window", () => {
  it("reaches a .delete() several lines down (the radar_scan_events shape)", () => {
    const src = [
      "const { error } = await supabaseAdmin",
      '  .from("radar_scan_events")',
      "  .delete()",
      '  .in("id", part);',
    ].join("\n");
    expect(at(src, "radar_scan_events")).toMatch(/\.delete\(\)/);
  });

  it("matches .delete with an argument (the submission_images shape)", () => {
    // `.delete({ count: "exact" })`. The empty-parens regex missed this one, on
    // the table the Privacy Policy names by hand.
    const src = [
      "const { error, count } = await supabaseAdmin",
      '  .from("submission_images")',
      '  .delete({ count: "exact" })',
      '  .in("id", slice);',
    ].join("\n");
    const found = deletedTablesFrom(src);
    expect(found).toContain("submission_images");
  });

  it("does not run past the semicolon into a neighbour's delete", () => {
    // The failure mode in the other direction, and the one that would fabricate
    // evidence rather than lose it.
    const src = [
      'const a = await supabaseAdmin.from("kept_forever").select("id");',
      'const b = await supabaseAdmin.from("swept_nightly").delete().lt("created_at", cutoff);',
    ].join("\n");
    expect(at(src, "kept_forever")).not.toMatch(/\.delete\(/);
    expect(at(src, "swept_nightly")).toMatch(/\.delete\(/);
  });

  it("a semicolon inside a comment does not end the statement", () => {
    // Sabotage-checked: removing the comment branch truncates this chain.
    //
    // The parser ALSO skips strings, and this test deliberately no longer
    // claims to cover that. It cannot: inside a supabase chain every string
    // literal sits within an argument list, so a semicolon in one is already
    // protected by the depth counter. Disabling string-skipping outright left
    // this suite green, which is how I learned the assertion was decorative.
    // The branch stays because it is cheap and correct; the test says only what
    // it proves.
    const src = [
      "const r = await supabaseAdmin",
      '  .from("notes")',
      '  .eq("body", "b")   // and a ; in a comment',
      "  .delete();",
    ].join("\n");
    expect(at(src, "notes")).toMatch(/\.delete\(\)/);
  });

  it("a semicolon inside nested parens does not end it either", () => {
    const src = [
      "const r = await supabaseAdmin",
      '  .from("things")',
      '  .in("id", ids.map((x) => { const y = x; return y; }))',
      "  .delete();",
    ].join("\n");
    expect(at(src, "things")).toMatch(/\.delete\(\)/);
  });

  it("finds the deletes this repo is known to perform", () => {
    // Guards the guard against a rename or a walk that stops finding files:
    // every assertion above passes on a parser that returns nothing useful.
    const found = deletedTables();
    for (const t of [
      "submission_images",
      "radar_scan_events",
      "ingested_listings",
      "email_deliveries",
      "cron_runs",
    ]) {
      expect(found.has(t), `${t} has a delete in this repo and the scan missed it`).toBe(true);
    }
    expect(declaredTables().size, "no tables parsed from the migrations").toBeGreaterThan(100);
  });
});

/** Run the file-level matcher over a source string, without touching disk. */
function deletedTablesFrom(src) {
  const out = [];
  for (const m of src.matchAll(/\.from\(\s*"([a-z0-9_]+)"\s*\)/g)) {
    if (/\.delete\(/.test(statementAt(src, m.index))) out.push(m[1]);
  }
  return out;
}
