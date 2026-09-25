// The reconnect toast. An item whose row reached the server but whose photos
// did not is saved, and saying "still queued" or "failed" about it sends the
// seller to enter the garment a second time.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  count: vi.fn(),
  toast: {
    loading: vi.fn(() => "t1"),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/offline-queue", () => ({
  flushIntakeQueue: mocks.flush,
  queuedIntakeCount: mocks.count,
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (sel: (s: { user: { id: string } }) => unknown) => sel({ user: { id: "me" } }),
}));
vi.mock("@/lib/pwa", () => ({ ensureServiceWorker: vi.fn() }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

const { useOfflineIntakeSync } = await import("@/hooks/use-offline-intake");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function Probe() {
  useOfflineIntakeSync();
  return null;
}

async function mountAndSync() {
  const client = new QueryClient();
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
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
  mocks.count.mockReset().mockResolvedValue(1);
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

  it("says synced when everything went up", async () => {
    mocks.flush.mockResolvedValue({ ...base, synced: 2 });
    await mountAndSync();
    expect(mocks.toast.success).toHaveBeenCalledWith("Synced 2 offline items.", { id: "t1" });
  });
});
