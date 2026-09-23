// Offline intake replay: a source typed in offline and photos staged offline
// must both reach the server on flush. fake-indexeddb is scoped to this file.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const upsert = vi.fn();
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => ({ upsert: (...args: unknown[]) => upsert(...args) }),
  },
}));
vi.mock("@/lib/sentry", () => ({ captureException: vi.fn() }));
const uploadItemPhoto = vi.fn();
vi.mock("@/lib/item-photo-upload", () => ({
  uploadItemPhoto: (...args: unknown[]) => uploadItemPhoto(...args),
}));

import {
  enqueueIntake,
  flushIntakeQueue,
  MAX_PHOTO_ATTEMPTS,
  queuedIntakeCount,
} from "@/lib/offline-queue";
import type { InventoryItemInsert } from "@/types/database";

const OWNER = "00000000-0000-0000-0000-00000000000a";
const payload = { user_id: OWNER, title: "Wool coat", source_id: null } as InventoryItemInsert;
const photo = (name: string, sortOrder: number) => ({
  blob: new Blob(["x"], { type: "image/jpeg" }),
  name,
  photoType: "front" as const,
  photoRole: null,
  sortOrder,
});

async function drain() {
  // Leave nothing queued between tests.
  rpc.mockResolvedValue({ data: "src-new", error: null });
  upsert.mockResolvedValue({ error: null });
  uploadItemPhoto.mockResolvedValue({});
  while ((await queuedIntakeCount()) > 0) await flushIntakeQueue();
}

beforeEach(async () => {
  await drain();
  rpc.mockReset();
  upsert.mockReset();
  uploadItemPhoto.mockReset();
  rpc.mockResolvedValue({ data: "src-new", error: null });
  upsert.mockResolvedValue({ error: null });
  uploadItemPhoto.mockResolvedValue({});
});

describe("flushIntakeQueue", () => {
  it("creates an offline-named source, then inserts the item with its id", async () => {
    await enqueueIntake(payload, { newSourceName: "Goodwill bins" });
    const res = await flushIntakeQueue();

    expect(res).toMatchObject({ synced: 1, failed: 0 });
    expect(rpc).toHaveBeenCalledWith("get_or_create_source", {
      p_user_id: OWNER,
      p_name: "Goodwill bins",
      p_source_type: "other",
    });
    const row = upsert.mock.calls[0]![0] as { source_id: string };
    expect(row.source_id).toBe("src-new");
    expect(await queuedIntakeCount()).toBe(0);
  });

  it("uploads queued photos to the new item after the insert", async () => {
    await enqueueIntake(payload, { photos: [photo("a.jpg", 0), photo("b.jpg", 1)] });
    const res = await flushIntakeQueue();

    expect(res).toMatchObject({ synced: 1, failed: 0, photosDropped: 0 });
    expect(uploadItemPhoto).toHaveBeenCalledTimes(2);
    const itemId = (upsert.mock.calls[0]![0] as { id: string }).id;
    const first = uploadItemPhoto.mock.calls[0]![0] as {
      itemId: string;
      ownerFolder: string;
      sortOrder: number;
      file: File;
    };
    expect(first).toMatchObject({ itemId, ownerFolder: OWNER, sortOrder: 0 });
    expect(first.file.name).toBe("a.jpg");
  });

  it("an item whose row saved is synced, not failed, while its photo retries", async () => {
    await enqueueIntake(payload, {
      newSourceName: "Bins",
      photos: [photo("a.jpg", 0), photo("b.jpg", 1)],
    });
    uploadItemPhoto.mockImplementation(async ({ file }: { file: File }) => {
      if (file.name === "b.jpg") throw new Error("upload refused");
      return {};
    });

    const first = await flushIntakeQueue();
    // The row exists; calling it failed sends the seller to enter it again.
    expect(first).toMatchObject({
      synced: 1,
      failed: 0,
      firstError: null,
      photosPending: 1,
      firstPhotoError: "upload refused",
    });
    expect(await queuedIntakeCount()).toBe(1);

    uploadItemPhoto.mockReset();
    uploadItemPhoto.mockResolvedValue({});
    rpc.mockClear();
    upsert.mockClear();
    const second = await flushIntakeQueue();
    // Only the photo was left, so the item is not counted a second time.
    expect(second).toMatchObject({ synced: 0, failed: 0, photosPending: 0 });
    expect(uploadItemPhoto).toHaveBeenCalledTimes(1);
    expect((uploadItemPhoto.mock.calls[0]![0] as { file: File }).file.name).toBe("b.jpg");
    // The item row and the source were settled on the first pass.
    expect(rpc).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(await queuedIntakeCount()).toBe(0);
  });

  it("retries a photo under the same photoId every time", async () => {
    await enqueueIntake(payload, { photos: [photo("a.jpg", 0), photo("b.jpg", 1)] });
    uploadItemPhoto.mockRejectedValue(new Error("upload refused"));
    await flushIntakeQueue();
    await flushIntakeQueue();

    const ids = uploadItemPhoto.mock.calls.map(
      (c) => (c[0] as { file: File; photoId: string }),
    );
    const byName = (n: string) => ids.filter((c) => c.file.name === n).map((c) => c.photoId);
    const a = byName("a.jpg");
    const b = byName("b.jpg");
    expect(a).toHaveLength(2);
    expect(a[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(a[1]).toBe(a[0]);
    expect(b[1]).toBe(b[0]);
    expect(b[0]).not.toBe(a[0]);
  });

  it("gives up on a photo that never uploads and reports it", async () => {
    await enqueueIntake(payload, { photos: [photo("bad.jpg", 0)] });
    uploadItemPhoto.mockRejectedValue(new Error("not an image"));

    let last = await flushIntakeQueue();
    for (let i = 1; i < MAX_PHOTO_ATTEMPTS; i++) last = await flushIntakeQueue();

    expect(last).toMatchObject({ synced: 0, failed: 0, photosDropped: 1, photosPending: 0 });
    expect(await queuedIntakeCount()).toBe(0);
  });

  it("does not spend an attempt when the network dropped before the upload", async () => {
    await enqueueIntake(payload, { photos: [photo("a.jpg", 0)] });
    uploadItemPhoto.mockRejectedValue(new TypeError("Failed to fetch"));

    for (let i = 0; i < MAX_PHOTO_ATTEMPTS + 2; i++) {
      const res = await flushIntakeQueue();
      expect(res).toMatchObject({ photosDropped: 0, photosPending: 1 });
    }
    expect(await queuedIntakeCount()).toBe(1);

    // A real refusal still counts from zero after all that.
    uploadItemPhoto.mockRejectedValue(new Error("not an image"));
    for (let i = 0; i < MAX_PHOTO_ATTEMPTS - 1; i++) await flushIntakeQueue();
    expect(await queuedIntakeCount()).toBe(1);
    expect(await flushIntakeQueue()).toMatchObject({ photosDropped: 1 });
  });

  it("does not try the upload at all while the device is offline", async () => {
    await enqueueIntake(payload, { photos: [photo("b.jpg", 0)] });
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      for (let i = 0; i < MAX_PHOTO_ATTEMPTS + 1; i++) {
        expect(await flushIntakeQueue()).toMatchObject({ photosPending: 1, photosDropped: 0 });
      }
      expect(uploadItemPhoto).not.toHaveBeenCalled();
    } finally {
      onLine.mockRestore();
    }
    expect(await flushIntakeQueue()).toMatchObject({ photosPending: 0 });
    expect(uploadItemPhoto).toHaveBeenCalledTimes(1);
  });

  it("leaves the item queued when the source RPC fails", async () => {
    await enqueueIntake(payload, { newSourceName: "Bins" });
    rpc.mockResolvedValue({ data: null, error: new Error("offline") });

    const res = await flushIntakeQueue();
    expect(res).toMatchObject({ synced: 0, failed: 1, firstError: "offline" });
    expect(upsert).not.toHaveBeenCalled();
    expect(await queuedIntakeCount()).toBe(1);
  });
});
