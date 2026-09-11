// US-3381 AC1 + AC4. The admin JSONL training-data export.
//
// The handler was wrapped in a try/catch, and the submissions read inside it
// dropped `error`. A PostgrestFilterBuilder RESOLVES with { data: null, error }
// on a 400 or an RLS refusal, so the catch never saw it: submissionMap stayed
// empty, every line of the export got garment_type "unknown" and
// garment_category "unknown", and the file downloaded under a green "Training
// data exported" toast. A fine-tuning set silently stripped of its garment
// labels is worse than no export, because nothing downstream can tell.
//
// THE MOCK RESOLVES AND NEVER REJECTS, except in the one case that says so.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const REVIEW = {
  id: "review-1",
  grade_report_id: "report-1",
  original_score: 7.5,
  adjusted_score: 8,
  review_notes: "hem wear understated",
  reviewed_at: "2026-09-01T12:00:00Z",
};

const REPORT = {
  id: "report-1",
  submission_id: "sub-1",
  overall_score: 7.5,
  grade_tier: "good",
  fabric_condition_score: 7,
  structural_integrity_score: 8,
  cosmetic_appearance_score: 7,
  functional_elements_score: 8,
  odor_cleanliness_score: 8,
  confidence_score: 0.9,
  ai_summary: "light wear",
  model_version: "v3",
};

let submissionsError: unknown = null;
let submissionsRejects = false;

function tableResult(table: string) {
  if (table === "submissions") {
    if (submissionsRejects) return Promise.reject(new Error("network down"));
    // Resolves. Never rejects. This is the whole point.
    return Promise.resolve({
      data: submissionsError
        ? null
        : [{ id: "sub-1", garment_type: "jacket", garment_category: "outerwear" }],
      error: submissionsError,
    });
  }
  if (table === "human_reviews") return Promise.resolve({ data: [REVIEW], error: null });
  if (table === "grade_reports") return Promise.resolve({ data: [REPORT], error: null });
  return Promise.resolve({ data: [], error: null });
}

function chain(table: string) {
  const self: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "order", "limit"]) self[k] = () => self;
  self["then"] = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => tableResult(table).then(onFulfilled, onRejected);
  return self;
}

vi.mock("@/lib/supabase", () => ({
  supabase: { from: (table: string) => chain(table) },
}));

const downloads: { name: string; body: string }[] = [];
vi.mock("@/lib/download", () => ({
  downloadBlob: (blob: Blob, name: string) => {
    downloads.push({ name, body: (blob as unknown as { __text?: string }).__text ?? "" });
  },
}));

const toasts: { kind: string; title: string }[] = [];
vi.mock("sonner", () => ({
  toast: {
    success: (t: string) => toasts.push({ kind: "success", title: t }),
    error: (t: string) => toasts.push({ kind: "error", title: t }),
    info: (t: string) => toasts.push({ kind: "info", title: t }),
    warning: (t: string) => toasts.push({ kind: "warning", title: t }),
    message: () => {},
  },
}));

// The six admin panels and the charts have nothing to do with this handler.
vi.mock("@/components/admin/grading-monitor-panel", () => ({ GradingMonitorPanel: () => null }));
vi.mock("@/components/admin/grading-eval-candidates-panel", () => ({ GradingEvalCandidatesPanel: () => null }));
vi.mock("@/components/admin/grading-calibration-panel", () => ({ GradingCalibrationPanel: () => null }));
vi.mock("@/components/admin/grading-canary-panel", () => ({ GradingCanaryPanel: () => null }));
vi.mock("@/components/admin/grading-accuracy-panel", () => ({ GradingAccuracyPanel: () => null }));
vi.mock("@/components/admin/listing-prompt-performance-panel", () => ({ ListingPromptPerformancePanel: () => null }));
vi.mock("@/components/admin/admin-mfa-gate", () => ({ MfaStepUpDialog: () => null }));
vi.mock("recharts", () => {
  const Noop = () => null;
  return {
    Bar: Noop, XAxis: Noop, YAxis: Noop, Tooltip: Noop,
    ResponsiveContainer: Noop, CartesianGrid: Noop, Line: Noop,
    ComposedChart: Noop, Legend: Noop,
  };
});
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
}));

const { AdminAiModelsPage } = await import("@/pages/admin/ai-models");

// Blob#text() is async and jsdom's Blob does not expose the parts, so capture
// the JSONL on the way in instead.
const RealBlob = globalThis.Blob;
class CapturingBlob extends RealBlob {
  __text: string;
  constructor(parts: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options);
    this.__text = parts.map((p) => String(p)).join("");
  }
}
globalThis.Blob = CapturingBlob as unknown as typeof Blob;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  act(() => {
    root = createRoot(container!);
    root.render(
      h(
        QueryClientProvider,
        { client: qc },
        h(MemoryRouter, null, h(AdminAiModelsPage)),
      ),
    );
  });
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function clickExport() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Export JSONL",
  );
  expect(button, "no Export JSONL button rendered").toBeTruthy();
  await act(async () => {
    (button as HTMLElement).click();
  });
  await settle();
}

beforeEach(() => {
  submissionsError = null;
  submissionsRejects = false;
  downloads.length = 0;
  toasts.length = 0;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("the training-data export: the read whose catch was dead", () => {
  it("refuses to ship an unlabeled set when the read RESOLVES with an error", async () => {
    submissionsError = {
      code: "42501",
      message: "permission denied for table submissions",
    };
    mount();
    await settle();
    await clickExport();

    expect(downloads).toEqual([]);
    expect(toasts.map((t) => t.kind)).toContain("error");
    expect(toasts.find((t) => t.kind === "error")!.title).toBe("Export failed");
    expect(toasts.map((t) => t.title)).not.toContain("Training data exported");
  });

  it("still reports a real rejection, which is all the catch ever caught", async () => {
    submissionsRejects = true;
    mount();
    await settle();
    await clickExport();

    expect(downloads).toEqual([]);
    expect(toasts.map((t) => t.title)).toContain("Export failed");
  });

  it("exports with the real garment labels when the read lands", async () => {
    mount();
    await settle();
    await clickExport();

    expect(downloads).toHaveLength(1);
    const line = JSON.parse(downloads[0]!.body.split("\n")[0]!);
    expect(line.garment_type).toBe("jacket");
    expect(line.garment_category).toBe("outerwear");
    expect(toasts.map((t) => t.title)).toContain("Training data exported");
  });
});
