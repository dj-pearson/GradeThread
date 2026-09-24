import { beforeEach, describe, expect, it, vi } from "vitest";

// SUB-07: the CSV export is complete, deduplicated and filter-aware.
//
// The fake below serves `submissions` the way PostgREST does: filters applied,
// then a HARD cap of 1000 rows per response whatever range was asked for. The
// old export asked once with no range, so it got 1000 of 2,500 and said nothing.

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  submissions: [] as Row[],
  csv: "",
  filename: "",
}));

const CAP = 1000;

vi.mock("@/lib/supabase", () => {
  function builder(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let range: [number, number] | null = null;
    let inIds: string[] | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), b),
      is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), b),
      in: (c: string, v: string[]) => ((inIds = v), preds.push((r) => v.includes(String(r[c]))), b),
      or: () => b,
      gte: (c: string, v: string) => (preds.push((r) => String(r[c]) >= v), b),
      lt: (c: string, v: string) => (preds.push((r) => String(r[c]) < v), b),
      lte: (c: string, v: string) => (preds.push((r) => String(r[c]) <= v), b),
      order: () => b,
      range: (from: number, to: number) => ((range = [from, to]), b),
      then: (resolve: (v: unknown) => unknown) => {
        if (table === "grade_reports") return resolve({ data: [], error: null });
        void inIds;
        const rows = state.submissions.filter((r) => preds.every((p) => p(r)));
        const [from, to] = range ?? [0, rows.length - 1];
        const slice = rows.slice(from, Math.min(to + 1, from + CAP));
        return resolve({ data: slice, error: null });
      },
    };
    return b;
  }
  return { supabase: { from: (t: string) => builder(t) } };
});

vi.mock("@/lib/download", () => ({
  csvBlob: (content: string) => content,
  downloadBlob: (content: string, filename: string) => {
    state.csv = content;
    state.filename = filename;
  },
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const { exportSubmissionsCsv } = await import("@/lib/submissions-export");
const { NO_SUBMISSION_FILTERS } = await import("@/lib/submission-list-query");

const OWNER = "owner-1";

function makeRows(n: number, extra: (i: number) => Row = () => ({})): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s-${String(i).padStart(5, "0")}`,
    user_id: OWNER,
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    title: `Item ${i}`,
    brand: null,
    garment_type: "jacket",
    garment_category: "outerwear",
    status: "completed",
    superseded_at: null,
    ...extra(i),
  }));
}

function csvRows(): string[] {
  return state.csv.split("\n").slice(1);
}

beforeEach(() => {
  state.csv = "";
  state.filename = "";
});

describe("exportSubmissionsCsv (SUB-07)", () => {
  it("writes all 2,500 rows past the per-response row cap", async () => {
    state.submissions = makeRows(2500);
    const n = await exportSubmissionsCsv(OWNER);
    expect(n).toBe(2500);
    expect(csvRows()).toHaveLength(2500);
    // One global order, newest first.
    expect(csvRows()[0]).toContain("Item 2499");
    expect(csvRows()[2499]).toContain("Item 0");
  });

  it("leaves out superseded retakes and other owners' rows", async () => {
    state.submissions = [
      ...makeRows(4, (i) => (i === 1 ? { superseded_at: "2026-02-01T00:00:00Z" } : {})),
      ...makeRows(3, () => ({ user_id: "someone-else" })),
    ];
    expect(await exportSubmissionsCsv(OWNER)).toBe(3);
    expect(state.csv).not.toContain("Item 1,");
  });

  it("honours the status filter on screen", async () => {
    state.submissions = makeRows(6, (i) => ({ status: i % 2 ? "completed" : "failed" }));
    const n = await exportSubmissionsCsv(OWNER, {
      filters: { ...NO_SUBMISSION_FILTERS, status: "completed" },
    });
    expect(n).toBe(3);
    for (const line of csvRows()) expect(line).toContain(",Completed,");
  });

  it("the selected-id export sorts once across chunks", async () => {
    state.submissions = makeRows(250);
    const ids = state.submissions.map((r) => String(r.id));
    // Shuffle the selection so chunk order differs from row order.
    ids.reverse();
    expect(await exportSubmissionsCsv(OWNER, { ids })).toBe(250);
    expect(csvRows()[0]).toContain("Item 249");
    expect(csvRows()[249]).toContain("Item 0");
    expect(state.filename).toContain("_250_selected_");
  });
});
