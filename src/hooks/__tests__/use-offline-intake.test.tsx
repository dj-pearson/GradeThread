// The reconnect toast. An item whose row reached the server but whose photos
// did not is saved, and saying "still queued" or "failed" about it sends the
// seller to enter the garment a second time. The sync is mounted once for the
// whole dashboard, so it runs on any page.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  count: vi.fn(),
  toast: {
    dismiss: vi.fn(),
    loading: vi.fn(() => "t1"),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/offline-queue", () => ({
  flushIntakeQueueExclusive: mocks.flush,
  queueCounts: mocks.count,
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: { user: { id: string } }) => unknown) => sel({ user: { id: "me" } }),
}));
vi.mock("@/lib/pwa", () => ({ ensureServiceWorker: vi.fn() }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const { OfflineIntakeSync } = await import("@/hooks/use-offline-intake");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;


async function mountAndSync() {
  const client = new QueryClient();
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/dashboard/flipdesk/items"]}>
          <OfflineIntakeSync />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const base = {
  synced: 0,
  syncedIds: [] as string[],
  failed: 0,
  firstError: null,
  photosDropped: 0,
  photosPending: 0,
  firstPhotoError: null,
  photosUnprocessable: 0,
  firstUnprocessableError: null,
};

beforeEach(() => {
  mocks.flush.mockReset();
  mocks.count.mockReset().mockResolvedValue({ itemsPending: 1, photosPending: 0 });
  for (const fn of Object.values(mocks.toast)) fn.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("offline sync toast", () => {
  it("says saved with photos pending, not failed, when only photos are left", async () => {
    mocks.flush.mockResolvedValue({
      ...base,
      synced: 1,
      photosPending: 2,
      firstPhotoError: "upload refused",
    });
    await mountAndSync();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      "Saved 1 offline item, 2 photos pending. Will retry.",
      expect.objectContaining({ id: "t1", description: "upload refused" }),
    );
  });

  it("still reports a failed item as queued", async () => {
    mocks.flush.mockResolvedValue({ ...base, failed: 1, firstError: "RLS refused" });
    await mountAndSync();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("1 still queued"),
      expect.objectContaining({ description: "RLS refused" }),
    );
  });

  it("names a photo this device could not prepare, with the reason", async () => {
    mocks.flush.mockResolvedValue({
      ...base,
      synced: 1,
      photosUnprocessable: 1,
      firstUnprocessableError: "HEIC conversion failed.",
    });
    await mountAndSync();
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      "1 offline photo could not be prepared on this device. Add a different one from the item page.",
      expect.objectContaining({ description: "HEIC conversion failed." }),
    );
  });

  it("counts and flushes only the signed-in user's records", async () => {
    mocks.flush.mockResolvedValue({ ...base, synced: 1 });
    await mountAndSync();
    expect(mocks.count).toHaveBeenCalledWith("me");
    expect(mocks.flush).toHaveBeenCalledWith("me");
  });

  it("offers to review the items it synced", async () => {
    mocks.flush.mockResolvedValue({ ...base, synced: 2, syncedIds: ["a", "b"] });
    await mountAndSync();
    const opts = mocks.toast.success.mock.calls[0]![1] as { action: { label: string } };
    expect(opts.action.label).toBe("Review 2 items");
  });

  it("does nothing when another flush holds the lock", async () => {
    mocks.flush.mockResolvedValue(null);
    await mountAndSync();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.toast.dismiss).toHaveBeenCalledWith("t1");
  });

  it("flushes on reconnect while the seller is on another page", async () => {
    mocks.count.mockResolvedValue({ itemsPending: 0, photosPending: 0 });
    await mountAndSync();
    expect(mocks.flush).not.toHaveBeenCalled();
    mocks.count.mockResolvedValue({ itemsPending: 1, photosPending: 0 });
    mocks.flush.mockResolvedValue({ ...base, synced: 1, syncedIds: ["a"] });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mocks.flush).toHaveBeenCalledWith("me");
  });

  it("says synced when everything went up", async () => {
    mocks.flush.mockResolvedValue({ ...base, synced: 2 });
    await mountAndSync();
    expect(mocks.toast.success).toHaveBeenCalledWith(
      "Synced 2 offline items.",
      expect.objectContaining({ id: "t1" }),
    );
  });
});
