// US-3381 AC1 + AC4. The publish dialog's scheduled_publish_at read.
//
// It was `const { data: listingRows } = await supabase...` inside a try that has
// only a `finally`, so the error was dropped twice over: a refusal RESOLVES
// with { data: null, error }, and there was no catch to see it even if it had
// rejected. Every row then read as unscheduled, the dialog's "N scheduled"
// count said zero, and the seller confirmed a publish that goes live NOW over
// a schedule they had set. Nothing on screen could have told them.
//
// THE MOCK RESOLVES AND NEVER REJECTS.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";

let scheduleError: unknown = null;
let scheduleRows: { inventory_item_id: string; scheduled_publish_at: string | null }[] = [];

function listingsChain() {
  const self: Record<string, unknown> = {};
  for (const k of ["select", "in", "eq"]) self[k] = () => self;
  self["then"] = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve({
      data: scheduleError ? null : scheduleRows,
      error: scheduleError,
    }).then(onFulfilled);
  return self;
}

vi.mock("@/lib/supabase", () => ({
  supabase: { from: () => listingsChain() },
}));

vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ blockers: [] }),
    }),
}));

const warnings: { fallback?: string; nextStep?: string }[] = [];
vi.mock("@/lib/toast-error", () => ({
  toastError: () => ({}),
  toastWarning: (_e: unknown, fallback?: string, ctx?: { nextStep?: string }) => {
    warnings.push({ fallback, nextStep: ctx?.nextStep });
    return {};
  },
}));

const { usePublishPreflight } = await import(
  "@/pages/flipdesk/autolister/use-publish-preflight"
);

const JOB = {
  inventory_item_id: "item-1",
  listing_id: "listing-1",
  status: "success",
} as never;

type Api = ReturnType<typeof usePublishPreflight>;
let api: Api | null = null;

function Probe() {
  api = usePublishPreflight({
    jobs: [JOB],
    // eBay disconnected, so the background wave stays out of the way and this
    // test is about the dialog's own read.
    ebayConnected: false,
    titleOf: () => "Blue jacket",
  });
  return null;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(h(Probe));
  });
}

async function openDialog() {
  await act(async () => {
    await api!.open([JOB]);
  });
}

beforeEach(() => {
  scheduleError = null;
  scheduleRows = [];
  warnings.length = 0;
  api = null;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("the schedule read that had neither an error check nor a catch", () => {
  it("warns, and says what publishing now would do, on a RESOLVED refusal", async () => {
    scheduleError = {
      code: "42501",
      message: "permission denied for table listings",
    };
    mount();
    await openDialog();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.fallback).toBe("Couldn't check which drafts are scheduled.");
    expect(warnings[0]!.nextStep).toContain("scheduled draft will go live now");
    // The dialog still opens and still validates: the schedule flag is the only
    // thing missing, and refusing to publish at all would be the wrong trade.
    expect(api!.dialogOpen).toBe(true);
    expect(api!.items[0]!.blockersLoaded).toBe(true);
  });

  it("stays quiet and flags the scheduled draft when the read answers", async () => {
    scheduleRows = [
      { inventory_item_id: "item-1", scheduled_publish_at: "2026-10-01T09:00:00Z" },
    ];
    mount();
    await openDialog();

    expect(warnings).toEqual([]);
    expect(api!.items[0]!.scheduledFor).toBe("2026-10-01T09:00:00Z");
  });

  it("a real empty answer is not a failure", async () => {
    scheduleRows = [];
    mount();
    await openDialog();

    expect(warnings).toEqual([]);
    expect(api!.items[0]!.scheduledFor).toBeNull();
  });
});
