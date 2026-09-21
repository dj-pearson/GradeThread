// US-3214 AC2/AC3: the submit control, and the two presses it must swallow.
//
// The money fix is the server's (00821's index plus the reorder in
// lib/grading-submit.ts, proved by scripts/check-one-open-grade.mjs and
// src/tests/one-open-grade_test.ts). What is asserted here is the SCREEN: that
// a double click sends one request, that the hold survives the response, and
// that grading an already-graded garment asks first and names the price.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const submitMutate = vi.fn<(a: Record<string, unknown>) => Promise<unknown>>(
  () => Promise.resolve({ submitted: 1, failed: 0, results: [] }),
);
const validateMutate = vi.fn<(a: Record<string, unknown>) => Promise<unknown>>(
  () => Promise.resolve({
    user: {
      plan: "starter",
      grades_used_this_month: 0,
      plan_limit: 5,
      grades_remaining: 5,
      included_remaining: 2,
      credit_balance: 7,
      unlimited: false,
    },
    items: [{
      inventory_item_id: "item-1",
      tier: "standard",
      cost: 2.99,
      ready: true,
      blockers: [],
      warnings: [],
      title: "Jacket",
      garment_type: "outerwear",
      garment_category: "jacket",
      required_photo_types_missing: [],
    }],
    total_cost: 2.99,
    can_submit: true,
    limit_exceeded: false,
  }),
);
type ConfirmOpts = { title: string; description?: string };
const confirmMock = vi.fn<(o: ConfirmOpts) => Promise<boolean>>(
  () => Promise.resolve(true),
);

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => confirmMock }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  },
}));

let submissions: Array<Record<string, unknown>> = [];
vi.mock("@/hooks/use-grading", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/hooks/use-grading");
  return {
    ...actual,
    useItemGradingSubmissions: () => ({ data: submissions, isLoading: false }),
    useSubmitForGrading: () => ({ mutateAsync: submitMutate, isPending: false }),
    useValidateGrading: () => ({ mutateAsync: validateMutate, isPending: false }),
  };
});

const { GradeThisItemCard } = await import("@/components/flipdesk/grade-this-item-card");

function item(over: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    title: "Carhartt Detroit jacket",
    brand: "Carhartt",
    category: "jacket",
    garment_type: "outerwear",
    garment_category: "jacket",
    grade_value: null,
    grade_label: null,
    certificate_url: null,
    updated_at: "2026-09-21T10:00:00.000Z",
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(over: Record<string, unknown> = {}, ready = true): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  act(() => {
    root = createRoot(container!);
    root.render(
      h(
        QueryClientProvider,
        { client: qc },
        h(
          MemoryRouter,
          null,
          h(GradeThisItemCard, {
            item: item(over) as never,
            preview: { ready, blockers: [], warnings: [] } as never,
          }),
        ),
      ),
    );
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function buttonMatching(re: RegExp): HTMLButtonElement {
  const el = Array.from(document.querySelectorAll("button")).find((b) =>
    re.test(b.textContent ?? "")
  );
  if (!el) throw new Error(`no button matching ${re}`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  submissions = [];
  submitMutate.mockClear();
  validateMutate.mockClear();
  confirmMock.mockClear();
  confirmMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("a double click sends one request (AC2)", () => {
  it("two clicks in ONE frame produce one submit", async () => {
    // THE CASE THIS STORY IS NAMED FOR. isPending becomes true in a state
    // update, so both clicks in a single frame read the old value; the
    // synchronous latch is what stops the second.
    render();
    const btn = buttonMatching(/^Submit/);
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(submitMutate).toHaveBeenCalledTimes(1);
  });

  it("and stays held AFTER the request settles", async () => {
    render();
    const btn = buttonMatching(/^Submit/);
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(submitMutate).toHaveBeenCalledTimes(1);
    // A seller reading the toast and pressing again is the other half.
    expect(buttonMatching(/^Submit/).disabled).toBe(true);
    await act(async () => {
      buttonMatching(/^Submit/).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(submitMutate).toHaveBeenCalledTimes(1);
  });

  it("the hold releases, so a real retry is still possible", async () => {
    render();
    await act(async () => {
      buttonMatching(/^Submit/).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(buttonMatching(/^Submit/).disabled).toBe(false);
  });
});

describe("an already-graded garment asks first (AC3)", () => {
  it("reads Grade it again, never Submit", () => {
    render({ grade_value: 8.5, grade_label: "Excellent" });
    expect(container!.textContent).toContain("Grade it again");
    expect(container!.textContent).not.toContain("Submit for");
  });

  it("names what it costs, from a live read", async () => {
    render({ grade_value: 8.5 });
    await act(async () => {
      buttonMatching(/Grade it again/).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(validateMutate).toHaveBeenCalled();
    const opts = confirmMock.mock.calls[0]![0];
    expect(opts.description ?? "").toContain("2 grades left on your plan");
  });

  it("falls back to credits when the plan bundle is spent", async () => {
    validateMutate.mockResolvedValueOnce({
      user: { included_remaining: 0, credit_balance: 7, unlimited: false },
      items: [],
      total_cost: 0,
      can_submit: true,
      limit_exceeded: false,
    });
    render({ grade_value: 8.5 });
    await act(async () => {
      buttonMatching(/Grade it again/).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    const opts = confirmMock.mock.calls[0]![0];
    expect(opts.description ?? "").toMatch(/costs \d+ credit/);
    expect(opts.description ?? "").toContain("You have 7");
  });

  it("says so rather than looking free when the price cannot be read", async () => {
    validateMutate.mockRejectedValueOnce(new Error("offline"));
    render({ grade_value: 8.5 });
    await act(async () => {
      buttonMatching(/Grade it again/).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    const opts = confirmMock.mock.calls[0]![0];
    expect(opts.description ?? "").toContain("couldn't check what it costs");
  });

  it("a refusal submits nothing", async () => {
    confirmMock.mockResolvedValue(false);
    render({ grade_value: 8.5 });
    await act(async () => {
      buttonMatching(/Grade it again/).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(confirmMock).toHaveBeenCalled();
    expect(submitMutate).not.toHaveBeenCalled();
  });

  it("a yes submits once", async () => {
    render({ grade_value: 8.5 });
    await act(async () => {
      buttonMatching(/Grade it again/).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(submitMutate).toHaveBeenCalledTimes(1);
  });
});
