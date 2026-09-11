// US-3381 AC2. The four AutoLister read hooks throw on a refused read now
// (US-3376), and the queue rendered `= {}` for every one of them -- so a
// refusal painted blank titles, blank thumbnails and an empty review column
// ONCE per retry and said nothing. A blank column is an answer: it reads as
// "this draft has no title and no review flags", which is the one thing a
// refused read must never be allowed to say beside a Publish button.
//
// This drives the page with the three queries reporting isError and asserts
// what the seller actually sees.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const JOBS = [
  {
    inventory_item_id: "item-1",
    listing_id: "listing-1",
    status: "success",
    confidence: 0.9,
    error: null,
  },
];

const BATCH = {
  id: "batch-1",
  item_count: 1,
  succeeded_count: 1,
  failed_count: 0,
  status: "completed",
  error: null,
};

let metaError = false;
let coversError = false;
let reviewError = false;
const refetched: string[] = [];

function queryStub(name: string, isError: boolean) {
  return {
    data: isError ? undefined : {},
    isError,
    isFetching: false,
    isLoading: false,
    refetch: () => {
      refetched.push(name);
      return Promise.resolve({});
    },
  };
}

vi.mock("@/pages/flipdesk/autolister/use-item-meta", () => ({
  useAutolisterItemMeta: () => queryStub("meta", metaError),
}));
vi.mock("@/pages/flipdesk/autolister/use-item-covers", () => ({
  ITEM_COVERS_KEY: "autolister_item_covers",
  useAutolisterItemCovers: () => queryStub("covers", coversError),
}));
vi.mock("@/pages/flipdesk/autolister/use-listing-review", () => ({
  useAutolisterListingReview: () => queryStub("review", reviewError),
}));
vi.mock("@/pages/flipdesk/autolister/use-size-conflicts", () => ({
  sizeCheckableDraft: (d: unknown) => d,
  useSizeConflicts: () => ({}),
  useApplySizeFix: () => () => Promise.resolve(),
}));
vi.mock("@/hooks/use-autolister", () => ({
  useAutolisterBatch: () => ({
    data: { batch: BATCH, jobs: JOBS },
    isLoading: false,
    error: null,
  }),
  useRetryFailedAutolister: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useResumeAutolister: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRunPhotoQa: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBulkPublish: () => ({ run: vi.fn(), running: false, results: {} }),
}));
vi.mock("@/hooks/use-ebay", () => ({
  useEbayConnection: () => ({ data: null }),
}));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: () => ({ select: () => ({ in: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }) }) },
}));
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }) }));
vi.mock("sonner", () => ({
  toast: { success: () => {}, error: () => {}, warning: () => {}, info: () => {}, message: () => {} },
}));

const { FlipdeskAutolisterQueuePage } = await import(
  "@/pages/flipdesk/autolister-queue"
);

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
        h(
          MemoryRouter,
          { initialEntries: ["/dashboard/flipdesk/autolister/queue?batch=batch-1"] },
          h(FlipdeskAutolisterQueuePage),
        ),
      ),
    );
  });
}

function alertText(): string {
  return Array.from(document.querySelectorAll('[role="alert"]'))
    .map((n) => n.textContent ?? "")
    .join(" | ");
}

beforeEach(() => {
  metaError = false;
  coversError = false;
  reviewError = false;
  refetched.length = 0;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("a refused column read is not a blank column", () => {
  it("says nothing at all when every read lands", () => {
    mount();
    expect(alertText()).toBe("");
  });

  it("names the missing columns and says why they are blank", () => {
    metaError = true;
    coversError = true;
    reviewError = true;
    mount();
    const text = alertText();
    expect(text).toContain("item titles and photo scores");
    expect(text).toContain("thumbnails");
    expect(text).toContain("review flags and prices");
    // The distinction the seller cannot make on their own.
    expect(text).toContain("not because the drafts are empty");
  });

  it("names only the read that failed", () => {
    coversError = true;
    mount();
    const text = alertText();
    expect(text).toContain("thumbnails");
    expect(text).not.toContain("review flags");
  });

  it("offers a retry, and retries only the failed reads", () => {
    reviewError = true;
    mount();
    const button = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Try again",
    );
    expect(button).toBeTruthy();
    act(() => {
      (button as HTMLElement).click();
    });
    expect(refetched).toEqual(["review"]);
  });
});
