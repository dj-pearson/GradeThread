// V4: the Badge Studio offers only the caller's own certificates, and only the
// ones the public certificate view will actually show.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const calls: Array<[string, unknown[]]> = [];
const results: Record<string, { data: unknown; error: unknown }> = {};

function chain(table: string) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "not", "is", "in", "order", "limit"]) {
    q[m] = (...args: unknown[]) => {
      calls.push([`${table}.${m}`, args]);
      return q;
    };
  }
  q.maybeSingle = () => Promise.resolve(results[table]);
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(results[table]).then(resolve, reject);
  return q;
}

vi.mock("@/lib/supabase", () => ({
  supabase: { from: (t: string) => chain(t) },
}));

const {
  fetchMyCertificates,
  lookupOwnedCertificate,
  isPubliclyShownCert,
} = await import("@/hooks/use-badge-studio");

type Row = Parameters<typeof isPubliclyShownCert>[0];

function row(over: Partial<Row> = {}, sub: Record<string, unknown> = {}): Row {
  return {
    certificate_id: "11111111-1111-4111-8111-111111111111",
    overall_score: 8.5,
    grade_tier: "Excellent",
    finalized_at: "2026-09-01T00:00:00Z",
    review_status: "approved",
    submissions: {
      user_id: "me",
      title: "Levi's 501",
      brand: "Levi's",
      status: "completed",
      flagged: false,
      moderation_status: null,
      ...sub,
    },
    ...over,
  } as Row;
}

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(results)) delete results[k];
});

describe("isPubliclyShownCert mirrors public_grade_reports", () => {
  it("accepts approved and modified, unflagged rows", () => {
    expect(isPubliclyShownCert(row())).toBe(true);
    expect(isPubliclyShownCert(row({ review_status: "modified" }))).toBe(true);
  });

  it("accepts a flagged row whose moderation was approved", () => {
    expect(isPubliclyShownCert(row({}, { flagged: true, moderation_status: "approved" }))).toBe(true);
  });

  it("rejects preliminary, pending-review and flagged-pending rows", () => {
    expect(isPubliclyShownCert(row({ review_status: "preliminary" }))).toBe(false);
    expect(isPubliclyShownCert(row({}, { status: "pending_review" }))).toBe(false);
    expect(isPubliclyShownCert(row({}, { flagged: true, moderation_status: "pending" }))).toBe(false);
    expect(isPubliclyShownCert(row({ certificate_id: null }))).toBe(false);
  });

  it("is pinned to the latest definition of the view's WHERE clause", () => {
    // If the view changes, this fails and the predicate above has to be
    // re-read against it, or the studio starts offering badges that 404.
    const dir = "supabase/migrations";
    const latest = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) =>
        /CREATE (OR REPLACE )?VIEW public\.public_grade_reports/i.test(
          readFileSync(join(dir, f), "utf8"),
        ),
      )
      .pop()!;
    const sql = readFileSync(join(dir, latest), "utf8");
    const view = sql.slice(sql.search(/CREATE (OR REPLACE )?VIEW public\.public_grade_reports/i));
    const where = view.slice(view.indexOf("WHERE gr.certificate_id"), view.indexOf(";"));
    expect(where.replace(/\s+/g, " ").trim()).toBe(
      "WHERE gr.certificate_id IS NOT NULL " +
        "AND gr.review_status IN ('approved', 'modified') " +
        "AND s.status IS DISTINCT FROM 'pending_review' " +
        "AND (s.flagged IS NOT TRUE OR s.moderation_status = 'approved')",
    );
  });
});

describe("fetchMyCertificates", () => {
  it("scopes the query to the caller and applies the public predicate", async () => {
    results.grade_reports = {
      data: [row(), row({ certificate_id: "22222222-2222-4222-8222-222222222222" }, { flagged: true, moderation_status: "pending" })],
      error: null,
    };
    results.public_passport_links = { data: [], error: null };
    const out = await fetchMyCertificates("uid-123");
    expect(calls).toContainEqual(["grade_reports.eq", ["submissions.user_id", "uid-123"]]);
    expect(calls).toContainEqual(["grade_reports.in", ["review_status", ["approved", "modified"]]]);
    expect(calls).toContainEqual(["grade_reports.neq", ["submissions.status", "pending_review"]]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Levi's 501", brand: "Levi's" });
  });

  it("throws when the passport-link read fails instead of dropping it", async () => {
    results.grade_reports = { data: [row()], error: null };
    results.public_passport_links = { data: null, error: new Error("boom") };
    await expect(fetchMyCertificates("uid-123")).rejects.toThrow("boom");
  });
});

describe("lookupOwnedCertificate", () => {
  it("reports a certificate outside the caller's own as not owned", async () => {
    results.grade_reports = { data: null, error: null };
    const out = await lookupOwnedCertificate("uid-123", "33333333-3333-4333-8333-333333333333");
    expect(out).toEqual({ state: "not_owned" });
    expect(calls).toContainEqual(["grade_reports.eq", ["submissions.user_id", "uid-123"]]);
  });
});

describe("lookupOwnedCertificate on a regraded item", () => {
  it("says the certificate was superseded rather than that it is not the caller's", async () => {
    results.grade_reports = {
      data: { ...row(), superseded_at: "2026-09-10T00:00:00Z" },
      error: null,
    };
    const out = await lookupOwnedCertificate("uid-123", "11111111-1111-4111-8111-111111111111");
    expect(out).toEqual({ state: "superseded" });
    // Still owner-scoped, and no longer filtered to the active report only.
    expect(calls).toContainEqual(["grade_reports.eq", ["submissions.user_id", "uid-123"]]);
    expect(calls).not.toContainEqual(["grade_reports.is", ["superseded_at", null]]);
  });
});
