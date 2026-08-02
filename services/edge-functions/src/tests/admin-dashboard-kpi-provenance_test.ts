// US-2390: no admin KPI may be derived by counting rows in JavaScript.
//
// GET /admin-dashboard/summary used to load every submission, every grade
// report and every sale, then compute the headline numbers with
// `array.filter(...).length`. That is not merely slow. PostgREST enforces
// `db-max-rows` on any response and reports the truncation ONLY in a
// Content-Range header that supabase-js does not surface, so past that ceiling
// each KPI was measured on a fraction of the corpus and came back looking
// completely ordinary. An operator reading "average grade 7.8" had no way to
// tell it was a slice.
//
// The distinction this guard holds is between the two ways a number can be
// wrong:
//
//   A COUNT can be exact. `count: "exact", head: true` is answered by the
//   server, reads zero rows, and cannot be truncated by a row ceiling. Every
//   KPI here except the mean is expressible that way, so every one of them is.
//
//   A MEAN needs values, so it cannot be a count. It is read capped and
//   newest-first, and the response carries `averageGradeSampleSize` and
//   `averageGradeTruncated` so the number arrives with its own provenance. A
//   stated sample is honest; a silent one is the bug.
//
// This is a SOURCE SCAN rather than a behavioural test on purpose. The failure
// mode is someone adding a KPI the convenient way -- `rows.filter(...).length`
// off an array that is already in scope -- and no runtime assertion catches
// that until the corpus outgrows the ceiling in production, which is exactly
// when nobody is looking.
import { assert, assertEquals } from "@std/assert";

const SOURCE = await Deno.readTextFile(
  new URL("../routes/admin-dashboard.ts", import.meta.url),
);

/** The `kpis` object literal, which is what the dashboard renders. */
function kpiBlock(): string {
  const start = SOURCE.indexOf("const kpis = {");
  assert(start > 0, "could not find the kpis literal -- did it get renamed?");
  const end = SOURCE.indexOf("\n  };", start);
  assert(end > start, "could not find the end of the kpis literal");
  return SOURCE.slice(start, end);
}

Deno.test("US-2390: every count-shaped KPI comes from an exact server count", () => {
  const block = kpiBlock();
  // Each of these must be fed by a `.count` off a head:true query, not by
  // measuring an array that was pulled into memory.
  for (
    const kpi of [
      "totalUsers",
      "activeSubscribers",
      "submissionsToday",
      "pendingReviews",
    ]
  ) {
    const line = block.split("\n").find((l) => l.trim().startsWith(`${kpi}:`));
    assert(line, `KPI ${kpi} disappeared from the summary payload`);
    assert(
      line.includes(".count"),
      `${kpi} is not read from a server-side count: ${line.trim()}`,
    );
  }
});

Deno.test("US-2390: no KPI measures the length of a fetched array", () => {
  const block = kpiBlock();
  // `.length` on rows pulled into memory is the exact shape that was silently
  // truncated. The ONE legitimate use is the mean's own sample size, which is
  // reported rather than used as a denominator for anything else.
  const offenders = block
    .split("\n")
    .filter((l) => /\.length\b/.test(l))
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("averageGradeSampleSize:"))
    // averageGradeTruncated spans two lines; its continuation legitimately
    // compares the counted total against the sample size.
    .filter((l) => !l.startsWith("averageGradeTruncated:"))
    .filter((l) => !l.includes("completedReportCount > meanRows.length"))
    .filter((l) => !l.startsWith("//"));
  assertEquals(
    offenders,
    [],
    "A KPI is counting rows in JS again. PostgREST can truncate that read " +
      "with no error and no flag, which does not make the number fail -- it " +
      "makes it plausible. Use count:'exact',head:true.",
  );
});

Deno.test("US-2390: the ratio KPIs use counted denominators", () => {
  const block = kpiBlock();
  // disputeRate and aiAccuracy are ratios, so BOTH sides have to be exact. A
  // counted numerator over a filtered-array denominator is still wrong, and is
  // the easier half to overlook.
  assert(
    block.includes("completedSubmissionCount > 0"),
    "disputeRatePercent's denominator is not the counted one",
  );
  assert(
    block.includes("completedReportCount > 0"),
    "aiAccuracyPercent's denominator is not the counted one",
  );
  assert(
    block.includes("highConfidenceRes.count"),
    "aiAccuracyPercent's numerator is not a server-side count",
  );
});

Deno.test("US-2390: the mean carries its provenance and is ordered", () => {
  // A capped mean is only acceptable because the sample is deliberate and
  // declared. Drop the ordering and it becomes an arbitrary slice; drop the
  // sample-size field and it becomes a silent one. Either alone reintroduces
  // the bug in a form that still renders a believable number.
  assert(
    SOURCE.includes('.order("created_at", { ascending: false })'),
    "the average-grade sample is no longer newest-first, so it is arbitrary",
  );
  assert(
    SOURCE.includes("averageGradeSampleSize"),
    "the average no longer reports how many grades it measured",
  );
  assert(
    SOURCE.includes("averageGradeTruncated"),
    "the average no longer reports whether older grades exist beyond it",
  );
  assert(
    SOURCE.includes("AVERAGE_GRADE_SAMPLE = 500"),
    "the sample cap must stay well under the assumed db-max-rows ceiling, or " +
      "the server can cut the sample short and the flag under-reports",
  );
});

Deno.test("US-2390: the raw reads no longer feed any KPI", () => {
  // The raw arrays still exist -- the client's funnel, cohorts and top-users
  // table genuinely need rows -- but nothing in kpis may read them again.
  // This is the line that keeps the remaining unbounded reads from being able
  // to corrupt a headline number: at worst now they shorten a chart.
  const block = kpiBlock();
  for (const arr of ["users", "submissions", "reports"]) {
    assert(
      !new RegExp(`\\b${arr}\\s*\\.\\s*(filter|length|reduce)`).test(block),
      `kpis reads the raw ${arr} array again`,
    );
  }
});
