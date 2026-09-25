// Offline intake replay: a source typed in offline and photos staged offline
// must both reach the server on flush. fake-indexeddb is scoped to this file.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const upsert = vi.fn();
vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    // upsert(...).select("id"): the rows it returns say whether the row is new.
    from: () => ({
      upsert: (...args: unknown[]) => ({ select: () => upsert(...args) }),
    }),
  },
}));
const captureException = vi.fn();
vi.mock("@/lib/sentry", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
}));
const uploadItemPhoto = vi.fn();
vi.mock("@/lib/item-photo-upload", () => ({
  uploadItemPhoto: (...args: unknown[]) => uploadItemPhoto(...args),
  PhotoPrepError: class PhotoPrepError extends Error {},
}));

import {
  clearOfflineIntakeQueue,
  enqueueIntake,
  enqueuePhotosForItem,
  flushIntakeQueueExclusive,
  queueCounts,
  flushIntakeQueue,
  MAX_PHOTO_ATTEMPTS,
  queuedIntakeCount,
} from "@/lib/offline-queue";
import { PhotoPrepError } from "@/lib/item-photo-upload";
import type { InventoryItemInsert } from "@/types/database";

const OWNER = "00000000-0000-0000-0000-00000000000a";
/** The signed-in auth user doing the queueing; a workspace member, say. */
const ME = "00000000-0000-0000-0000-0000000000b1";
const OTHER = "00000000-0000-0000-0000-0000000000b2";
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
  upsert.mockImplementation(async (row: { id: string }) => ({ data: [{ id: row.id }], error: null }));
  uploadItemPhoto.mockResolvedValue({});
  while ((await queuedIntakeCount(ME)) > 0) await flushIntakeQueue(ME);
}

beforeEach(async () => {
  await drain();
  rpc.mockReset();
  upsert.mockReset();
  uploadItemPhoto.mockReset();
  rpc.mockResolvedValue({ data: "src-new", error: null });
  upsert.mockImplementation(async (row: { id: string }) => ({ data: [{ id: row.id }], error: null }));
  uploadItemPhoto.mockResolvedValue({});
});

describe("flushIntakeQueue", () => {
  it("creates an offline-named source, then inserts the item with its id", async () => {
    await enqueueIntake(payload, { queuedBy: ME, newSourceName: "Goodwill bins" });
    const res = await flushIntakeQueue(ME);

    expect(res).toMatchObject({ synced: 1, failed: 0 });
    expect(rpc).toHaveBeenCalledWith("get_or_create_source", {
      p_user_id: OWNER,
      p_name: "Goodwill bins",
      p_source_type: "other",
    });
    const row = upsert.mock.calls[0]![0] as { source_id: string };
    expect(row.source_id).toBe("src-new");
    expect(await queuedIntakeCount(ME)).toBe(0);
  });

  it("uploads queued photos to the new item after the insert", async () => {
    await enqueueIntake(payload, { queuedBy: ME, photos: [photo("a.jpg", 0), photo("b.jpg", 1)] });
    const res = await flushIntakeQueue(ME);

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
      queuedBy: ME,
      newSourceName: "Bins",
      photos: [photo("a.jpg", 0), photo("b.jpg", 1)],
    });
    uploadItemPhoto.mockImplementation(async ({ file }: { file: File }) => {
      if (file.name === "b.jpg") throw new Error("upload refused");
      return {};
    });

    const first = await flushIntakeQueue(ME);
    // The row exists; calling it failed sends the seller to enter it again.
    expect(first).toMatchObject({
      synced: 1,
      failed: 0,
      firstError: null,
      photosPending: 1,
      firstPhotoError: "upload refused",
    });
    expect(await queuedIntakeCount(ME)).toBe(1);

    uploadItemPhoto.mockReset();
    uploadItemPhoto.mockResolvedValue({});
    rpc.mockClear();
    upsert.mockClear();
    const second = await flushIntakeQueue(ME);
    // Only the photo was left, so the item is not counted a second time.
    expect(second).toMatchObject({ synced: 0, failed: 0, photosPending: 0 });
    expect(uploadItemPhoto).toHaveBeenCalledTimes(1);
    expect((uploadItemPhoto.mock.calls[0]![0] as { file: File }).file.name).toBe("b.jpg");
    // The item row and the source were settled on the first pass.
    expect(rpc).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(await queuedIntakeCount(ME)).toBe(0);
  });

  it("retries a photo under the same photoId every time", async () => {
    await enqueueIntake(payload, { queuedBy: ME, photos: [photo("a.jpg", 0), photo("b.jpg", 1)] });
    uploadItemPhoto.mockRejectedValue(new Error("upload refused"));
    await flushIntakeQueue(ME);
    await flushIntakeQueue(ME);

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
    await enqueueIntake(payload, { queuedBy: ME, photos: [photo("bad.jpg", 0)] });
    uploadItemPhoto.mockRejectedValue(new Error("not an image"));

    let last = await flushIntakeQueue(ME);
    for (let i = 1; i < MAX_PHOTO_ATTEMPTS; i++) last = await flushIntakeQueue(ME);

    expect(last).toMatchObject({ synced: 0, failed: 0, photosDropped: 1, photosPending: 0 });
    expect(await queuedIntakeCount(ME)).toBe(0);
  });

  it("does not spend an attempt when the network dropped before the upload", async () => {
    await enqueueIntake(payload, { queuedBy: ME, photos: [photo("a.jpg", 0)] });
    uploadItemPhoto.mockRejectedValue(new TypeError("Failed to fetch"));

    for (let i = 0; i < MAX_PHOTO_ATTEMPTS + 2; i++) {
      const res = await flushIntakeQueue(ME);
      expect(res).toMatchObject({ photosDropped: 0, photosPending: 1 });
    }
    expect(await queuedIntakeCount(ME)).toBe(1);

    // A real refusal still counts from zero after all that.
    uploadItemPhoto.mockRejectedValue(new Error("not an image"));
    for (let i = 0; i < MAX_PHOTO_ATTEMPTS - 1; i++) await flushIntakeQueue(ME);
    expect(await queuedIntakeCount(ME)).toBe(1);
    expect(await flushIntakeQueue(ME)).toMatchObject({ photosDropped: 1 });
  });

  it("does not try the upload at all while the device is offline", async () => {
    await enqueueIntake(payload, { queuedBy: ME, photos: [photo("b.jpg", 0)] });
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      for (let i = 0; i < MAX_PHOTO_ATTEMPTS + 1; i++) {
        expect(await flushIntakeQueue(ME)).toMatchObject({ photosPending: 1, photosDropped: 0 });
      }
      expect(uploadItemPhoto).not.toHaveBeenCalled();
    } finally {
      onLine.mockRestore();
    }
    expect(await flushIntakeQueue(ME)).toMatchObject({ photosPending: 0 });
    expect(uploadItemPhoto).toHaveBeenCalledTimes(1);
  });

  it("a photo this device cannot prepare is set aside at once, with its reason", async () => {
    await enqueueIntake(payload, { queuedBy: ME, photos: [photo("IMG_1.heic", 0), photo("b.jpg", 1)] });
    uploadItemPhoto.mockImplementation(async ({ file }: { file: File }) => {
      if (file.name === "IMG_1.heic") throw new PhotoPrepError("HEIC conversion failed.");
      return {};
    });

    const res = await flushIntakeQueue(ME);
    // One flush, not MAX_PHOTO_ATTEMPTS: nothing was sent, so there is no
    // server verdict to wait for, and the same bytes fail the same way again.
    expect(res).toMatchObject({
      synced: 1,
      photosDropped: 0,
      photosPending: 0,
      photosUnprocessable: 1,
      firstUnprocessableError: "HEIC conversion failed.",
      firstPhotoError: null,
    });
    expect(uploadItemPhoto).toHaveBeenCalledTimes(2);
    expect(await queuedIntakeCount(ME)).toBe(0);
  });

  it("a replay after the itemSaved write failed does not count the item again", async () => {
    await enqueueIntake(payload, { queuedBy: ME, photos: [photo("a.jpg", 0)] });
    // The item row is inserted, then IndexedDB refuses to record itemSaved.
    const put = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementationOnce(() => {
        throw new Error("QuotaExceededError");
      });
    try {
      const first = await flushIntakeQueue(ME);
      expect(first).toMatchObject({ synced: 1, photosPending: 1 });
    } finally {
      put.mockRestore();
    }
    expect(uploadItemPhoto).not.toHaveBeenCalled();

    // The server already has the row: the ignore-duplicates upsert returns none.
    upsert.mockResolvedValue({ data: [], error: null });
    const second = await flushIntakeQueue(ME);
    expect(second).toMatchObject({ synced: 0, failed: 0, photosPending: 0 });
    // Same id both times, so the server matched the existing row, and the
    // photo went to that item.
    const ids = upsert.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(uploadItemPhoto).toHaveBeenCalledTimes(1);
    expect((uploadItemPhoto.mock.calls[0]![0] as { itemId: string }).itemId).toBe(ids[0]);
    expect(await queuedIntakeCount(ME)).toBe(0);
  });

  it("leaves the item queued when the source RPC fails", async () => {
    await enqueueIntake(payload, { queuedBy: ME, newSourceName: "Bins" });
    rpc.mockResolvedValue({ data: null, error: new Error("offline") });

    const res = await flushIntakeQueue(ME);
    expect(res).toMatchObject({ synced: 0, failed: 1, firstError: "offline" });
    expect(upsert).not.toHaveBeenCalled();
    expect(await queuedIntakeCount(ME)).toBe(1);
  });
});

describe("the queue belongs to whoever queued it", () => {
  it("a record queued by one user is invisible to another's count and flush", async () => {
    await enqueueIntake(payload, { queuedBy: ME, photos: [photo("a.jpg", 0)] });
    expect(await queuedIntakeCount(OTHER)).toBe(0);
    const res = await flushIntakeQueue(OTHER);
    expect(res).toMatchObject({ synced: 0, failed: 0 });
    expect(upsert).not.toHaveBeenCalled();
    expect(uploadItemPhoto).not.toHaveBeenCalled();
    expect(await queuedIntakeCount(ME)).toBe(1);
    await flushIntakeQueue(ME);
    expect(await queuedIntakeCount(ME)).toBe(0);
  });

  it("clearOfflineIntakeQueue deletes the database", async () => {
    await enqueueIntake(payload, { queuedBy: ME });
    await clearOfflineIntakeQueue();
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain("flipdesk-offline");
    expect(await queuedIntakeCount(ME)).toBe(0);
  });
});

describe("photos of an item saved online", () => {
  it("upload on the next flush against that item, with no second insert", async () => {
    await enqueuePhotosForItem({
      itemId: "item-1",
      ownerId: OWNER,
      title: "Wool coat",
      queuedBy: ME,
      photos: [{ ...photo("a.jpg", 100), id: "p-1" }],
    });
    expect(await queuedIntakeCount(ME)).toBe(1);
    const res = await flushIntakeQueue(ME);
    expect(upsert).not.toHaveBeenCalled();
    expect(res).toMatchObject({ synced: 0, failed: 0, photosPending: 0 });
    expect(uploadItemPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "item-1", ownerFolder: OWNER, sortOrder: 100, photoId: "p-1" }),
    );
    expect(await queuedIntakeCount(ME)).toBe(0);
  });
});

describe("flushing from anywhere", () => {
  it("a second concurrent flush does nothing", async () => {
    await enqueueIntake(payload, { queuedBy: ME });
    let release!: () => void;
    upsert.mockImplementation(
      (row: { id: string }) =>
        new Promise((r) => {
          release = () => r({ data: [{ id: row.id }], error: null });
        }),
    );
    const first = flushIntakeQueueExclusive(ME);
    await new Promise((r) => setTimeout(r, 20));
    expect(await flushIntakeQueueExclusive(ME)).toBeNull();
    release();
    expect(await first).toMatchObject({ synced: 1 });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("a dropped connection on a photo is not reported to Sentry", async () => {
    captureException.mockReset();
    await enqueueIntake(payload, { queuedBy: ME, photos: [photo("a.jpg", 0)] });
    uploadItemPhoto.mockRejectedValue(new TypeError("Failed to fetch"));
    const res = await flushIntakeQueue(ME);
    expect(res).toMatchObject({ synced: 1, photosPending: 1 });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("counts items and photos separately, and returns the ids it synced", async () => {
    await enqueueIntake(payload, { queuedBy: ME, id: "item-a", photos: [photo("a.jpg", 0), photo("b.jpg", 1)] });
    expect(await queueCounts(ME)).toEqual({ itemsPending: 1, photosPending: 2 });
    expect(await queueCounts(OTHER)).toEqual({ itemsPending: 0, photosPending: 0 });
    const res = await flushIntakeQueue(ME);
    expect(res.syncedIds).toEqual(["item-a"]);
  });
});
