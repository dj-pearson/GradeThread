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

  it("keeps a failed photo queued and retries only it, without re-creating the source", async () => {
    await enqueueIntake(payload, {
      newSourceName: "Bins",
      photos: [photo("a.jpg", 0), photo("b.jpg", 1)],
    });
    uploadItemPhoto.mockImplementation(async ({ file }: { file: File }) => {
      if (file.name === "b.jpg") throw new Error("network down");
      return {};
    });

    const first = await flushIntakeQueue();
    expect(first).toMatchObject({ synced: 0, failed: 1, firstError: "network down" });
    expect(await queuedIntakeCount()).toBe(1);

    uploadItemPhoto.mockReset();
    uploadItemPhoto.mockResolvedValue({});
    rpc.mockClear();
    const second = await flushIntakeQueue();
    expect(second).toMatchObject({ synced: 1, failed: 0 });
    expect(uploadItemPhoto).toHaveBeenCalledTimes(1);
    expect((uploadItemPhoto.mock.calls[0]![0] as { file: File }).file.name).toBe("b.jpg");
    // The source was resolved on the first pass and stored on the payload.
    expect(rpc).not.toHaveBeenCalled();
    expect((upsert.mock.calls[upsert.mock.calls.length - 1]![0] as { source_id: string }).source_id).toBe("src-new");
  });

  it("gives up on a photo that never uploads and reports it", async () => {
    await enqueueIntake(payload, { photos: [photo("bad.jpg", 0)] });
    uploadItemPhoto.mockRejectedValue(new Error("not an image"));

    let last = await flushIntakeQueue();
    for (let i = 1; i < MAX_PHOTO_ATTEMPTS; i++) last = await flushIntakeQueue();

    expect(last).toMatchObject({ synced: 1, photosDropped: 1 });
    expect(await queuedIntakeCount()).toBe(0);
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
