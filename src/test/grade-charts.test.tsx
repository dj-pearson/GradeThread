import { act } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GradeCharts } from "@/components/dashboard/grade-charts";
import {
  processChartData,
  type ChartReport,
  type ChartSubmission,
} from "@/lib/grade-chart-data";

// DASH-5: retakes count once, empty weeks are gaps not zeros, and a failed
// read says so instead of "no data yet".

const state = vi.hoisted(() => ({ fail: false }));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "order", "limit"]) {
        chain[m] = () => chain;
      }
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() =>
            state.fail
              ? { data: null, error: { message: "down" } }
              : { data: [], error: null }
          )
          .then(resolve, reject);
      return chain;
    },
  },
}));

const NOW = new Date("2026-09-23T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function sub(id: string, over: Partial<ChartSubmission> = {}): ChartSubmission {
  return {
    id,
    status: "completed",
    created_at: daysAgo(2),
    garment_type: "shirt",
    superseded_at: null,
    ...over,
  } as ChartSubmission;
}

function report(submission_id: string, score: number, tier = "Excellent"): ChartReport {
  return { submission_id, overall_score: score, grade_tier: tier } as ChartReport;
}

describe("processChartData", () => {
  it("counts a superseded original and its retake once", () => {
    const data = processChartData(
      [
        sub("orig", { superseded_at: daysAgo(1) }),
        sub("retake"),
      ],
      [report("orig", 6, "Good"), report("retake", 8, "Excellent")],
      NOW,
    );
    const total = data.gradeDistribution.reduce((a, b) => a + b.count, 0);
    expect(total).toBe(1);
    expect(data.gradeDistribution.find((d) => d.tier === "Excellent")!.count).toBe(1);
    expect(data.garmentTypeBreakdown).toEqual([{ name: "Shirt", value: 1 }]);
  });

  it("yields null, not 0, for a week with no grades", () => {
    const data = processChartData([sub("a")], [report("a", 9)], NOW);
    expect(data.avgGradeOverTime).toHaveLength(4);
    expect(data.avgGradeOverTime[3]!.average).toBe(9);
    for (const week of data.avgGradeOverTime.slice(0, 3)) {
      expect(week.average).toBeNull();
    }
  });
});

describe("GradeCharts", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    state.fail = false;
  });

  it("renders the load error, not 'no data', when the read fails", async () => {
    state.fail = true;
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <GradeCharts />
        </QueryClientProvider>,
      )
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Could not load"));
    expect(container.textContent).not.toMatch(/no (analytics data|grades to chart) yet/i);
  });

  it("uses the hex theme tokens directly, never hsl(var(--...))", () => {
    const src = readFileSync("src/components/dashboard/grade-charts.tsx", "utf8");
    expect(src).not.toContain("hsl(var(--");
    expect(src).toContain('.is("superseded_at", null)');
  });
});
