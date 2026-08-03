// US-2303: the 0.75 review threshold, and the difference between the two kinds
// of site that use it.
//
// The threshold is TUNABLE — `reviewConfidenceThreshold()` reads a DB-backed
// setting so the calibration report's recommended operating point can be applied
// without a deploy. Copies of the literal defeat that: lowering it in the admin
// UI moved the real gate while the admin agreement metric, the seller-facing
// suggestion and the browser extensions all kept deciding at 0.75.
//
// BUT NOT EVERY 0.75 IS A COPY OF THE GATE, and an indiscriminate sweep would
// have broken something worse than it fixed. `confidenceLabelFor` in
// admin-grading.ts must match the `public_certificate` SQL view byte for byte,
// because the admin queue and the public certificate label the SAME grade. If
// that bucket followed the tunable gate they would disagree about a certificate
// a buyer is looking at.
//
// So the sites are ENUMERATED, each with which kind it is. A rule that could
// tell them apart automatically does not exist — the difference is intent.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/**
 * Sites that make the REVIEW DECISION. Each must read the shared threshold, not
 * a literal. Keyed by file, with the symbol it has to use.
 */
const DECISION_SITES: Array<{ file: string; symbol: string; why: string }> = [
  {
    file: "services/edge-functions/src/routes/admin-grading.ts",
    symbol: "reviewConfidenceThreshold()",
    why: "the agreement metric counts what the gate caught, so it must score against the gate that ran",
  },
  {
    file: "src/components/analytics/listing-suggestions.tsx",
    symbol: "GRADING_REVIEW_CONFIDENCE_THRESHOLD",
    why: "tells the seller their grade is low-confidence — must mean the same thing as the gate",
  },
];

/**
 * Sites where 0.75 is a DISPLAY BUCKET pinned to a SQL view, not the gate.
 * These must NOT be converted. Enumerated so a future sweep reads the reason
 * instead of guessing.
 */
const PINNED_BUCKETS: Array<{ file: string; why: string }> = [
  {
    file: "services/edge-functions/src/routes/admin-grading.ts",
    why: "confidenceLabelFor mirrors the public_certificate view; moving it makes the admin queue disagree with the public certificate",
  },
  {
    file: "services/edge-functions/src/lib/passport-write.ts",
    why: "the passport's own confidence band, written alongside the same buckets",
  },
  {
    file: "src/lib/passport-confidence.ts",
    why: "the client half of the passport band — mirrors the stored label",
  },
  {
    file: "src/lib/community-recommendations.ts",
    why: "a recommendation strength label, unrelated to the review gate",
  },
];

describe("US-2303: one authoritative review threshold", () => {
  it("the edge threshold is tunable, not a constant", () => {
    const cfg = read("services/edge-functions/src/lib/ai-config.ts");
    // The DB-backed registry is what makes calibration applicable without a
    // deploy; the env var is only the fallback. If this ever became a plain
    // constant the whole story would silently regress.
    // Regex, not a multi-line string literal: the edge sources are CRLF, so a
    // `\n` anchor matches nothing and the assertion would fail for a reason
    // that has nothing to do with the threshold.
    expect(cfg).toMatch(
      /getSettingSync<number>\(\s*"grading_review_confidence_threshold"/,
    );
    expect(cfg).toContain("function reviewConfidenceThreshold()");
  });

  it("the review gate compares with < threshold, in one place", () => {
    // AC4: the comparison direction. `<` routes to review; `<=` would send a
    // grade sitting exactly on the threshold to a human, and `>` would invert
    // the gate entirely. One implementation, so there is one direction.
    const cfg = read("services/edge-functions/src/lib/ai-config.ts");
    expect(cfg).toContain("return priorNeedsReview || effectiveConfidence < threshold;");
  });

  it("the final re-derivation uses the CALIBRATED threshold", () => {
    // The story's note claimed grading-pipeline calls reconcileNeedsReview
    // "without the calibrated threshold, so it re-flags at the flat value and
    // makes calibration a no-op". That is wrong, and the reason is worth
    // pinning: the parameter's DEFAULT is reviewConfidenceThreshold(), and a JS
    // default is evaluated per call — so omitting it reads the current setting
    // rather than a frozen one. Passing a literal here is what would break it.
    const pipeline = read("services/edge-functions/src/lib/grading-pipeline.ts");
    const call = pipeline.slice(pipeline.indexOf("reconcileNeedsReview("));
    const args = call.slice(0, call.indexOf(");"));
    expect(args).not.toMatch(/0\.\d+/);
  });

  it("every decision site reads the shared threshold", () => {
    for (const site of DECISION_SITES) {
      const src = read(site.file);
      expect(src, `${site.file}: ${site.why}`).toContain(site.symbol);
    }
  });

  it("no decision site compares a confidence score against a literal", () => {
    // Matched as the CONSTRUCT — a comparison of a confidence value against a
    // number — rather than by searching for "0.75", which appears in unrelated
    // maths (fit models, image adjustments, price curves) all over the tree.
    //
    // The gap between `confidence_score` and the operator can hold a `)` or a
    // cast, as in `Number(r.confidence_score) < 0.75`. An earlier version of
    // this used `\s*` there and matched NOTHING — the mutation that put the
    // literal back left the suite green, which is the whole failure mode this
    // guard exists to prevent, reproduced inside the guard.
    const pattern = /confidence[_A-Za-z]*[^\n]{0,12}?[<>]=?\s*0\.\d+/;

    // The pinned bucket function lives in one of these files. Removed by NAME
    // rather than filtered line by line, so the exemption is the declared
    // function and not any line that happens to look like it.
    const stripPinned = (src: string) => {
      const at = src.indexOf("function confidenceLabelFor(");
      if (at === -1) return src;
      const end = src.indexOf("\n}", at);
      return src.slice(0, at) + src.slice(end === -1 ? at : end);
    };

    for (const site of DECISION_SITES) {
      const src = stripPinned(read(site.file));
      const offenders = src
        .split("\n")
        .map((l, i) => [i + 1, l.trim()] as const)
        .filter(([, l]) => pattern.test(l) && !l.startsWith("//") && !l.startsWith("*"));
      expect(
        offenders,
        `${site.file} compares confidence to a literal — ${site.why}`,
      ).toEqual([]);
    }
  });

  it("the literal-comparison pattern actually matches one", () => {
    // Guard-the-guard, and it is not ceremony: the first version of the pattern
    // above silently matched nothing, so the case passed against a file that
    // did contain the defect. A canary is the only thing that tells a
    // never-matching regex apart from a clean tree.
    const pattern = /confidence[_A-Za-z]*[^\n]{0,12}?[<>]=?\s*0\.\d+/;
    expect(pattern.test("Number(r.confidence_score) < 0.75,")).toBe(true);
    expect(pattern.test("report.confidence_score < 0.75")).toBe(true);
    expect(pattern.test("confidenceScore >= 0.9")).toBe(true);
    // And does not fire on the fixed form.
    expect(pattern.test("Number(r.confidence_score) < reviewThreshold")).toBe(false);
  });

  it("the pinned display buckets are still pinned, and still explained", () => {
    // Guard-the-guard: an exemption that no longer applies is how the next
    // regression gets waved through. Each file must still contain a bucket
    // comparison, or its entry here is stale and should be deleted.
    for (const b of PINNED_BUCKETS) {
      const src = read(b.file);
      expect(src, `${b.file} no longer buckets confidence — drop its exemption`)
        .toMatch(/0\.(9|75|6)/);
    }
  });

  it("the SQL views still carry their own copies — AC2 is NOT done", () => {
    // Recorded as a failing-by-construction fact rather than left implicit: four
    // migrations bucket confidence with their own literals, and consolidating
    // them behind one function is a migration this pass did not write. If
    // someone later derives them from a shared function, this case is what tells
    // them the story can close.
    const dir = "supabase/migrations";
    const withCopies = readdirSync(resolve(process.cwd(), dir))
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => {
        const sql = read(`${dir}/${f}`);
        return /confidence_score\s*>=\s*0\.75/.test(sql);
      });
    expect(withCopies.length).toBeGreaterThan(0);
  });
});
