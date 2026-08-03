// US-2390: no admin dashboard number may be derived from rows pulled into JS.
//
// GET /admin-dashboard/summary used to load every submission, every grade
// report and every sale, then compute the headline numbers with
// `array.filter(...).length`. That is not merely slow. PostgREST enforces
// `db-max-rows` on any response and reports the truncation ONLY in a
// Content-Range header that supabase-js does not surface, so past that ceiling
// each number was measured on a fraction of the corpus and came back looking
// completely ordinary. An operator reading "average grade 7.8" had no way to
// tell it was a slice.
//
// The rule this guard now holds is absolute, and it is stronger than the one it
// held while the fix was half-done: THIS HANDLER READS NO ROWS AT ALL.
//
//   - Count-shaped numbers use `count: "exact", head: true`, which the server
//     answers from an index and which returns zero rows.
//   - Everything that needs values rather than a count -- the all-time mean, the
//     month's revenue, the 30-day chart buckets, and the funnel/cohort/top-user
//     analytics -- is aggregated in SQL (migration 00513) and comes back as a
//     bounded document.
//
// Because nothing returns rows, there is no longer any read here that a row
// ceiling can shorten, and so no number that can be quietly wrong. That is why
// the "the mean states its sample size" assertions from the previous pass are
// gone rather than relaxed: there is no sample left to describe.
//
// This is a SOURCE SCAN rather than a behavioural test on purpose. The failure
// mode is someone adding a number the convenient way -- `rows.filter(...).length`
// off an array that is already in scope -- and no runtime assertion catches
// that until the corpus outgrows the ceiling in production, which is exactly
// when nobody is looking.
import { assert, assertEquals } from "@std/assert";

const SOURCE = await Deno.readTextFile(
  new URL("../routes/admin-dashboard.ts", import.meta.url),
);

/** The whole `GET /summary` handler. */
function summaryHandler(): string {
  const start = SOURCE.indexOf('adminDashboardRoutes.get("/summary"');
  assert(start > 0, "could not find the /summary handler -- did it move?");
  const end = SOURCE.indexOf("\n});", start);
  assert(end > start, "could not find the end of the /summary handler");
  return SOURCE.slice(start, end);
}

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
  // truncated. There is no longer any legitimate exception here -- the last one
  // (the mean's own sample size) went away when the mean became an aggregate.
  const offenders = block
    .split("\n")
    .filter((l) => /\.length\b/.test(l))
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("//"));
  assertEquals(
    offenders,
    [],
    "A KPI is counting rows in JS again. PostgREST can truncate that read " +
      "with no error and no flag, which does not make the number fail -- it " +
      "makes it plausible. Use count:'exact',head:true or an SQL aggregate.",
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

Deno.test("US-2390: the value-shaped numbers come from SQL aggregates", () => {
  const block = kpiBlock();
  // The mean and the month's revenue are the two numbers that need VALUES and
  // therefore cannot be counts. Aggregating them in SQL is what makes them
  // exact; summing them in JS is what made them plausible-but-wrong.
  for (const [kpi, source] of [
    ["averageGrade", "agg.averageGrade"],
    ["revenueThisMonth", "agg.revenueThisMonth"],
  ]) {
    const line = block.split("\n").find((l) => l.trim().startsWith(`${kpi}:`));
    assert(line, `KPI ${kpi} disappeared from the summary payload`);
    assert(
      line.includes(source!),
      `${kpi} is not read from the SQL aggregate: ${line.trim()}`,
    );
  }
  assert(
    SOURCE.includes('supabaseAdmin.rpc("admin_dashboard_aggregates"'),
    "the aggregate RPC call is gone -- the mean is being derived some other way",
  );
});

Deno.test("US-2390: the summary handler reads NO rows", () => {
  // The load-bearing assertion, and the one that makes every other test here
  // hold by construction. A `.from(...).select(...)` without `head: true`
  // returns rows, and any read that returns rows can be silently shortened by
  // `db-max-rows`. Every legitimate need for values in this handler is served
  // by an RPC, which returns a bounded document instead.
  const handler = summaryHandler();
  const selects = [...handler.matchAll(/supabaseAdmin\s*\.from\([^;]*?;/gs)]
    .map((m) => m[0])
    .filter((stmt) => !/head:\s*true/.test(stmt));
  assertEquals(
    selects.map((s) => s.replace(/\s+/g, " ").slice(0, 120)),
    [],
    "The summary handler issues a read that returns rows. That read can be " +
      "truncated by db-max-rows with no error and no flag. Aggregate it in " +
      "SQL, or count it with head:true.",
  );
});

Deno.test("US-2390: the handler ships answers, not raw rows", () => {
  const handler = summaryHandler();
  // The client used to receive every user and submission row under `raw` and
  // aggregate them in a useMemo, believing it had the whole corpus. Sending
  // rows back is the same defect one layer out, so the key itself is barred.
  assert(
    !/\braw:\s*\{/.test(handler),
    "the summary payload ships raw rows again -- the client cannot tell a " +
      "truncated array from a complete one, which is the whole bug",
  );
  assert(
    handler.includes("analytics: {"),
    "the aggregated analytics document is gone from the payload",
  );
});

Deno.test("US-2390: the one capped read declares itself", () => {
  // The enrichment log is the only read left in this file that returns rows.
  // The cap is defensible -- it feeds a tuning signal, not an accounting figure
  // -- but a capped number sitting beside exact ones inherits their credibility
  // unless it says otherwise.
  assert(
    SOURCE.includes("ENRICHMENT_LOG_LIMIT"),
    "the enrichment-log cap is no longer a named constant",
  );
  assert(
    SOURCE.includes("truncated: logs.length >= ENRICHMENT_LOG_LIMIT"),
    "the enrichment-log response no longer reports whether it was truncated",
  );
});
