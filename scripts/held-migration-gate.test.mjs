// US-2346 AC4: the held-migration gate's parser.
//
// The git half needs a repo, so what is unit-tested here is the part that
// decides WHICH migrations count as held — the half that, if it silently
// matched nothing, would make the gate pass by doing nothing.

import { describe, expect, it } from "vitest";
import { heldMigrations } from "./held-migration-gate.mjs";

describe("US-2346: which headings count as HELD", () => {
  it("reads the real file's shape, emoji and all", () => {
    const doc = [
      "# PENDING MIGRATIONS",
      "",
      "## ⏳ HELD: 00512_job_lock_holder_release.sql (US-2311 job-lock holder check, 2026-08-02)",
      "- some prose",
      "",
      "## ⏳ HELD: 00511_submissions_protected_columns_guard.sql (US-2376, 2026-08-01)",
    ].join("\n");
    expect(heldMigrations(doc).map((h) => h.version)).toEqual(["00512", "00511"]);
    expect(heldMigrations(doc)[0].file).toBe(
      "supabase/migrations/00512_job_lock_holder_release.sql",
    );
  });

  it("ignores an APPLIED heading — this is the whole point of keying on the marker", () => {
    // Keying on the migration's EXISTENCE instead would block every push after
    // a migration is legitimately applied and its heading flipped.
    const doc = [
      "## ✅ APPLIED: 00506_items_full_quality_score.sql (US-2170, 2026-07-30)",
      "## ✅ APPLIED: 00505_grading_roi_period_filter.sql (US-2234, 2026-07-30)",
    ].join("\n");
    expect(heldMigrations(doc)).toEqual([]);
  });

  it("survives a lost emoji, because a copy-paste that drops it must not disarm the gate", () => {
    const doc = "## HELD: 00512_job_lock_holder_release.sql (US-2311)";
    expect(heldMigrations(doc).map((h) => h.version)).toEqual(["00512"]);
  });

  it("does not match the word HELD in prose", () => {
    const doc = [
      "Some paragraph explaining why a migration is HELD: it has not been applied.",
      "- **Apply order.** After 00511.",
    ].join("\n");
    expect(heldMigrations(doc)).toEqual([]);
  });

  it("returns nothing for a doc with no headings at all", () => {
    expect(heldMigrations("# PENDING MIGRATIONS\n\nNothing pending.\n")).toEqual([]);
  });

  it("matches the template line in the doc's own footer only if it is a real version", () => {
    // The footer shows `## ⏳ HELD: NNNNN_name.sql` as an instruction. NNNNN is
    // not five digits, so it must not be picked up as a pending migration.
    const doc = "Add one `## ⏳ HELD: NNNNN_name.sql (US-#### short title, YYYY-MM-DD)` heading";
    expect(heldMigrations(doc)).toEqual([]);
  });
});
