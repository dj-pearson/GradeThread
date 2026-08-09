// US-2303 AC2/AC3: the public certificate's confidence buckets have one home.
//
// public_grade_reports has SIXTEEN CREATE OR REPLACE revisions in the migration
// corpus, and every one of them re-derived the same four boundaries inline.
// That is not sixteen mistakes — it is what happens when the way to add a column
// is to paste the whole view and edit it. The seventeenth would have done it
// again.
//
// 00571 moves the buckets into public.grade_confidence_label(numeric) and has
// the live view call it. This test is what stops the next revision pasting the
// CASE back, because nothing else would: the view would still compile, still
// return a confidence_label, and still be right — until someone tuned the
// threshold and only some surfaces moved.
//
// ── WHY A CORPUS SCAN AND NOT A DATABASE TEST ───────────────────────────────
// The `db` verify lane proves the SQL applies; it does not prove that the LAST
// revision is the one calling the function. That is a property of the migration
// history, which is a file question.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "supabase", "migrations");
const VIEW_RE = /CREATE OR REPLACE VIEW public\.public_grade_reports AS/;

/** Every migration that (re)defines the public certificate view, in order. */
function viewRevisions(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => VIEW_RE.test(readFileSync(join(DIR, f), "utf8")));
}

describe("US-2303 AC2: the confidence buckets are defined once in SQL", () => {
  it("the LIVE view calls grade_confidence_label, not an inline CASE", () => {
    // The live view is the LAST revision, not the one the story's note names —
    // it said 00356, and three revisions have landed since (rubric factors,
    // video grading, live capture). Rewriting 00356's body would have silently
    // reverted four columns off the public certificate, because CREATE OR
    // REPLACE only refuses to DROP or reorder columns and those four are last.
    const revisions = viewRevisions();
    expect(revisions.length).toBeGreaterThan(1);
    const live = readFileSync(join(DIR, revisions[revisions.length - 1]!), "utf8");
    expect(live).toContain("public.grade_confidence_label(gr.confidence_score)");
    expect(live).not.toMatch(/WHEN gr\.confidence_score >= 0\.9/);
  });

  it("the function exists and is IMMUTABLE STRICT", () => {
    // IMMUTABLE so Postgres may inline it — STABLE would cost every certificate
    // read. STRICT so a NULL confidence returns NULL instead of falling through
    // to 'reviewed', which is what the old inline CASE did (NULL >= 0.9 is NULL,
    // so it hit ELSE and claimed a grade we never scored had been reviewed).
    const defn = readFileSync(join(DIR, "00571_grade_confidence_label_fn.sql"), "utf8");
    expect(defn).toMatch(/CREATE OR REPLACE FUNCTION public\.grade_confidence_label/);
    expect(defn).toContain("IMMUTABLE");
    expect(defn).toContain("STRICT");
  });

  it("no revision AFTER 00571 re-forks the buckets", () => {
    // The whole point. A seventeenth revision that pastes the CASE back would
    // compile, return a confidence_label and look right — until the threshold
    // moved and only some surfaces followed.
    const offenders = viewRevisions()
      .filter((f) => f > "00571")
      .filter((f) => /WHEN gr\.confidence_score >= 0\.9/.test(readFileSync(join(DIR, f), "utf8")));
    expect(
      offenders,
      "these revisions re-derive the confidence buckets inline — call " +
        "public.grade_confidence_label(gr.confidence_score) instead",
    ).toEqual([]);
  });

  it("the historical revisions are left alone", () => {
    // Applied migrations are immutable. The older revisions SHOULD still carry
    // the inline CASE — this asserts the fix did not rewrite history, which is
    // the other way this could have been done wrong.
    const older = viewRevisions().filter((f) => f < "00571");
    const withCase = older.filter((f) =>
      /WHEN gr\.confidence_score >= 0\.9/.test(readFileSync(join(DIR, f), "utf8"))
    );
    expect(withCase.length).toBeGreaterThan(0);
  });
});
