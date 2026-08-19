// US-9108: the grade read layer shared by /api/v1/grades and the connector's
// gradethread_get_grade / gradethread_list_grades tools.
//
// Two properties are worth protecting here.
//
//   1. The tenant scope, for the same reason as every other read on the edge:
//      the service-role client bypasses RLS, so a forgotten filter is a leak
//      rather than a denied query (US-268).
//   2. `pending_review`. A grade flagged for human review that a caller quotes
//      as final ends up in a live listing and changes underneath the seller.
//      It is derived from the STORED needs_human_review, not from re-comparing
//      confidence to 0.75 — the threshold is calibrated per category at grading
//      time, so a hardcoded comparison here would disagree with the pipeline
//      exactly where calibration matters.

import { assert, assertEquals, assertExists } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  clampGradesLimit,
  getBatch,
  getGrade,
  GRADES_PAGE_DEFAULT,
  GRADES_PAGE_MAX,
  listGrades,
} = await import("../lib/api-grades.ts");

const TENANT = "11111111-1111-4111-8111-111111111111";
const SUBMISSION_ID = "22222222-2222-4222-8222-222222222222";
const REPORT_ID = "33333333-3333-4333-8333-333333333333";

interface RecordedCall {
  table: string;
  filters: Array<{ op: string; column: string; value: unknown }>;
}

function recordingDb(rowsByTable: Record<string, unknown[]>) {
  const calls: RecordedCall[] = [];

  function builder(table: string) {
    const record: RecordedCall = { table, filters: [] };
    calls.push(record);
    const rows = rowsByTable[table] ?? [];

    const api: Record<string, unknown> = {
      eq(column: string, value: unknown) {
        record.filters.push({ op: "eq", column, value });
        return api;
      },
      is(column: string, value: unknown) {
        record.filters.push({ op: "is", column, value });
        return api;
      },
      in(column: string, value: unknown) {
        record.filters.push({ op: "in", column, value });
        return api;
      },
      order() {
        return api;
      },
      range() {
        return api;
      },
      maybeSingle() {
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve);
      },
    };
    return api;
  }

  return {
    calls,
    db: {
      from(table: string) {
        return { select: () => builder(table) };
      },
    },
  };
}

function submissionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBMISSION_ID,
    status: "completed",
    garment_type: "outerwear",
    garment_category: "jacket",
    title: "Carhartt Detroit Jacket",
    brand: "Carhartt",
    description: "Blanket-lined duck canvas",
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T11:00:00.000Z",
    ...overrides,
  };
}

function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID,
    submission_id: SUBMISSION_ID,
    overall_score: 8.5,
    grade_tier: "Excellent",
    fabric_condition_score: 8.5,
    structural_integrity_score: 9,
    cosmetic_appearance_score: 8,
    functional_elements_score: 8.5,
    odor_cleanliness_score: 9,
    confidence_score: 0.88,
    ai_summary: "Light wear at the cuffs.",
    detailed_notes: null,
    model_version: "v3",
    certificate_id: "GT-123456",
    needs_human_review: false,
    created_at: "2026-08-01T11:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tenant scoping
// ---------------------------------------------------------------------------

Deno.test("getGrade scopes on the submission id AND the tenant in one query", async () => {
  const { db, calls } = recordingDb({
    submissions: [submissionRow()],
    grade_reports: [reportRow()],
    human_reviews: [],
  });
  await getGrade(TENANT, SUBMISSION_ID, db);

  const submissionQuery = calls.find((c) => c.table === "submissions");
  assertExists(submissionQuery);
  const columns = submissionQuery.filters.map((f) => f.column);
  assert(columns.includes("id"));
  assert(columns.includes("user_id"));
  assertEquals(submissionQuery.filters.find((f) => f.column === "user_id")?.value, TENANT);
});

Deno.test("getGrade returns null for another tenant's submission, same as for a missing one", async () => {
  const { db } = recordingDb({ submissions: [], grade_reports: [], human_reviews: [] });
  assertEquals(await getGrade(TENANT, SUBMISSION_ID, db), null);
});

Deno.test("listGrades scopes on the tenant", async () => {
  const { db, calls } = recordingDb({
    submissions: [submissionRow()],
    grade_reports: [reportRow()],
    human_reviews: [],
  });
  await listGrades(TENANT, {}, db);

  const query = calls.find((c) => c.table === "submissions");
  assertExists(query);
  assertEquals(query.filters.find((f) => f.column === "user_id")?.value, TENANT);
});

// ---------------------------------------------------------------------------
// pending_review
// ---------------------------------------------------------------------------

Deno.test("a confident grade is not flagged pending", async () => {
  const { db } = recordingDb({
    submissions: [submissionRow()],
    grade_reports: [reportRow({ needs_human_review: false })],
    human_reviews: [],
  });
  const grade = await getGrade(TENANT, SUBMISSION_ID, db);
  assertEquals(grade?.grade_report?.needs_human_review, false);
  assertEquals(grade?.grade_report?.pending_review, false);
});

Deno.test("a flagged, unreviewed grade is pending_review", async () => {
  const { db } = recordingDb({
    submissions: [submissionRow()],
    grade_reports: [reportRow({ needs_human_review: true, confidence_score: 0.61 })],
    human_reviews: [],
  });
  const grade = await getGrade(TENANT, SUBMISSION_ID, db);
  assertEquals(grade?.grade_report?.pending_review, true);
});

Deno.test("a flagged grade that a human HAS reviewed is no longer pending", async () => {
  // Reporting it as pending forever would train a caller to ignore the flag,
  // which is worse than not having one.
  const { db } = recordingDb({
    submissions: [submissionRow()],
    grade_reports: [reportRow({ needs_human_review: true })],
    human_reviews: [{ grade_report_id: REPORT_ID }],
  });
  const grade = await getGrade(TENANT, SUBMISSION_ID, db);
  assertEquals(grade?.grade_report?.needs_human_review, true);
  assertEquals(grade?.grade_report?.pending_review, false);
});

Deno.test("pending_review comes from the stored flag, not from re-deriving confidence < 0.75", async () => {
  // Low confidence but NOT flagged: the pipeline's calibrated threshold for this
  // category accepted it, and this layer must not overrule that decision.
  const { db } = recordingDb({
    submissions: [submissionRow()],
    grade_reports: [reportRow({ confidence_score: 0.62, needs_human_review: false })],
    human_reviews: [],
  });
  const grade = await getGrade(TENANT, SUBMISSION_ID, db);
  assertEquals(grade?.grade_report?.pending_review, false);

  // High confidence but flagged (a defect-divergence trigger, not a confidence
  // one): still pending.
  const flagged = recordingDb({
    submissions: [submissionRow()],
    grade_reports: [reportRow({ confidence_score: 0.97, needs_human_review: true })],
    human_reviews: [],
  });
  const grade2 = await getGrade(TENANT, SUBMISSION_ID, flagged.db);
  assertEquals(grade2?.grade_report?.pending_review, true);
});

Deno.test("the list carries pending_review per row, so a page cannot hide a provisional grade", async () => {
  const { db } = recordingDb({
    submissions: [submissionRow()],
    grade_reports: [reportRow({ needs_human_review: true })],
    human_reviews: [],
  });
  const page = await listGrades(TENANT, {}, db);
  assertEquals(page.items[0].grade?.pending_review, true);
});

// ---------------------------------------------------------------------------
// Report lookup rules
// ---------------------------------------------------------------------------

Deno.test("only the ACTIVE report is read; superseded history is filtered out", async () => {
  // US-479: a regraded submission keeps its old reports. Returning one would
  // report a grade the seller can no longer see in the product.
  const { db, calls } = recordingDb({
    submissions: [submissionRow()],
    grade_reports: [reportRow()],
    human_reviews: [],
  });
  await getGrade(TENANT, SUBMISSION_ID, db);

  const reportQuery = calls.find((c) => c.table === "grade_reports");
  assertExists(reportQuery);
  const supersededFilter = reportQuery.filters.find((f) => f.column === "superseded_at");
  assertExists(supersededFilter, "the active-report filter is missing");
  assertEquals(supersededFilter.op, "is");
  assertEquals(supersededFilter.value, null);
});

Deno.test("a submission that has not finished grading returns no report rather than an error", async () => {
  const { db, calls } = recordingDb({
    submissions: [submissionRow({ status: "processing" })],
    grade_reports: [reportRow()],
    human_reviews: [],
  });
  const grade = await getGrade(TENANT, SUBMISSION_ID, db);
  assertEquals(grade?.status, "processing");
  assertEquals(grade?.grade_report, null);
  // And it does not waste a query looking for a report that cannot exist.
  assert(!calls.some((c) => c.table === "grade_reports"));
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

Deno.test("clampGradesLimit matches the endpoint's documented bounds", () => {
  assertEquals(clampGradesLimit(undefined), GRADES_PAGE_DEFAULT);
  assertEquals(clampGradesLimit(0), GRADES_PAGE_DEFAULT);
  assertEquals(clampGradesLimit(50), 50);
  assertEquals(clampGradesLimit(5000), GRADES_PAGE_MAX);
});

Deno.test("listGrades reports the page, total and total_pages the envelope needs", async () => {
  const { db } = recordingDb({
    submissions: [submissionRow()],
    grade_reports: [],
    human_reviews: [],
  });
  const page = await listGrades(TENANT, { page: 1, limit: 20 }, db);
  assertEquals(page.page, 1);
  assertEquals(page.limit, 20);
  assertEquals(page.total, 1);
  assertEquals(page.total_pages, 1);
});

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

const BATCH_ID = "44444444-4444-4444-8444-444444444444";

function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    status: "running",
    item_count: 10,
    succeeded_count: 7,
    failed_count: 1,
    error: null,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:05:00.000Z",
    ...overrides,
  };
}

Deno.test("getBatch scopes BOTH the batch and its job rows on the tenant", async () => {
  // The parent scope alone would be enough today. Scoping the job rows too
  // means a later refactor that reads them by batch_id cannot become reachable
  // with a foreign batch id.
  const { db, calls } = recordingDb({
    grading_batches: [batchRow()],
    grading_batch_jobs: [
      { id: "job-1", status: "succeeded", submission_id: SUBMISSION_ID, error: null },
    ],
  });
  await getBatch(TENANT, BATCH_ID, db);

  for (const table of ["grading_batches", "grading_batch_jobs"]) {
    const query = calls.find((c) => c.table === table);
    assertExists(query, `${table} was not queried`);
    assertEquals(
      query.filters.find((f) => f.column === "user_id")?.value,
      TENANT,
      `${table} was read without a tenant scope`,
    );
  }
});

Deno.test("getBatch returns null for an unknown or foreign batch id", async () => {
  const { db } = recordingDb({ grading_batches: [], grading_batch_jobs: [] });
  assertEquals(await getBatch(TENANT, BATCH_ID, db), null);
});

Deno.test("getBatch reports per-job outcomes, including the error for a failed garment", async () => {
  const { db } = recordingDb({
    grading_batches: [batchRow({ status: "completed", succeeded_count: 1, failed_count: 1 })],
    grading_batch_jobs: [
      { id: "job-1", status: "succeeded", submission_id: SUBMISSION_ID, error: null },
      { id: "job-2", status: "failed", submission_id: null, error: "front photo unreadable" },
    ],
  });
  const batch = await getBatch(TENANT, BATCH_ID, db);
  assertExists(batch);
  assertEquals(batch.results.length, 2);
  assertEquals(batch.results[0].grade_id, SUBMISSION_ID);
  assertEquals(batch.results[1].error, "front photo unreadable");
  // A partial-success batch is a normal outcome, not an error.
  assertEquals(batch.error, null);
});
