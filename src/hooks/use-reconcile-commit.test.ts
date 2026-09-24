// The photo-board commit: ownership of a linked item, what reaches the public
// bucket, and what a partial failure leaves behind.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };

interface Call {
  table: string;
  op: string;
  payload?: unknown;
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const calls: Call[] = [];
const uploads: { path: string; body: unknown }[] = [];
const removed: string[][] = [];
let linkedRow: Record<string, unknown> | null = null;
let existingPhotoTypes: string[] = [];
let uploadFailsOn: (n: number, path: string) => boolean = () => false;
let photoInsertError: unknown = null;
let uploadCount = 0;

function builder(table: string, op: string, result: Result, payload?: unknown) {
  calls.push({ table, op, payload });
  const self: Record<string, unknown> = {};
  for (const k of ["eq", "in", "is", "not", "order", "limit", "select"]) {
    self[k] = () => self;
  }
  self["single"] = () => Promise.resolve(result);
  self["maybeSingle"] = () => Promise.resolve(result);
  self["then"] = (onFulfilled: (v: Result) => unknown) =>
    Promise.resolve(result).then(onFulfilled);
  return self;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => ({
      insert: (payload: unknown) =>
        builder(
          table,
          "insert",
          table === "item_photos"
            ? { data: null, error: photoInsertError }
            : { data: { id: "item-new", status: "cataloged" }, error: null },
          payload,
        ),
      delete: () => builder(table, "delete", { data: null, error: null }),
      update: (payload: unknown) =>
        builder(table, "update", { data: null, error: null }, payload),
      select: () =>
        builder(
          table,
          "select",
          table === "item_photos"
            ? { data: existingPhotoTypes.map((t) => ({ photo_type: t })), error: null }
            : { data: linkedRow, error: null },
        ),
    }),
    storage: {
      from: () => ({
        upload: (path: string, body: unknown) => {
          uploadCount += 1;
          uploads.push({ path, body });
          if (uploadFailsOn(uploadCount, path)) {
            return Promise.reject(new Error("network dropped"));
          }
          return Promise.resolve({ data: { path }, error: null });
        },
        remove: (paths: string[]) => {
          removed.push(paths);
          return Promise.resolve({ data: null, error: null });
        },
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn/${p}` } }),
      }),
    },
  },
}));

vi.mock("@/lib/toast-error", () => ({
  toastWarning: () => ({}),
  toastError: () => ({}),
}));

const compressImage = vi.fn();
vi.mock("@/lib/image-utils", () => ({
  compressImage: (...a: unknown[]) => compressImage(...a),
}));
const advanceItemStatus = vi.fn(() => Promise.resolve());
vi.mock("@/lib/status-writer", () => ({
  advanceItemStatus: (...a: unknown[]) => (advanceItemStatus as (...x: unknown[]) => unknown)(...a),
}));

const { commitClusters, resolveItemId } = await import("@/hooks/use-reconcile-commit");

function file(name: string) {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
}

function photo(id: string, photoType: string) {
  return {
    id,
    file: file(`${id}.jpg`),
    capturedAt: null,
    photoType: photoType as "front",
    storagePath: null,
  };
}

beforeEach(() => {
  calls.length = 0;
  uploads.length = 0;
  removed.length = 0;
  linkedRow = null;
  existingPhotoTypes = [];
  uploadFailsOn = () => false;
  photoInsertError = null;
  uploadCount = 0;
  compressImage.mockReset();
  compressImage.mockImplementation(async () => ({
    blob: new Blob([new Uint8Array([9])], { type: "image/webp" }),
    width: 10,
    height: 10,
  }));
  advanceItemStatus.mockClear();
});

describe("resolveItemId", () => {
  const linkCluster = {
    clusterId: "c1",
    label: "Item 1",
    linkItemId: "item-1",
    photos: [],
  };

  it("rejects an item that belongs to a different workspace", async () => {
    linkedRow = { id: "item-1", user_id: OTHER, status: "cataloged", photo_count: 0 };
    await expect(resolveItemId(linkCluster, OWNER)).rejects.toThrow(
      "This item belongs to a different workspace",
    );
  });

  it("rejects an item that has been photographed since the picker loaded", async () => {
    linkedRow = { id: "item-1", user_id: OWNER, status: "cataloged", photo_count: 3 };
    await expect(resolveItemId(linkCluster, OWNER)).rejects.toThrow(/already has photos/);
  });

  it("rejects an item past the photo step", async () => {
    linkedRow = { id: "item-1", user_id: OWNER, status: "listed", photo_count: 0 };
    await expect(resolveItemId(linkCluster, OWNER)).rejects.toThrow(/can't be linked/);
  });

  it("accepts the owner's own photo-less item", async () => {
    linkedRow = { id: "item-1", user_id: OWNER, status: "drafted", photo_count: 0 };
    await expect(resolveItemId(linkCluster, OWNER)).resolves.toEqual({
      itemId: "item-1",
      currentStatus: "drafted",
      createdNew: false,
    });
  });
});

describe("commitClusters", () => {
  it("smoke: commits a new draft", async () => {
    const [r] = await commitClusters(
      [{ clusterId: "c1", label: "Item 1", linkItemId: null, photos: [photo("p1", "front")] }],
      OWNER,
      null,
    );
    expect(r!.ok).toBe(true);
    expect(r!.itemId).toBe("item-new");
    expect(r!.saved).toBe(1);
  });
});

describe("M3: the original file never reaches the public bucket", () => {
  it("skips a photo whose re-encode throws instead of uploading the original", async () => {
    compressImage.mockImplementation(async () => {
      throw new Error("HEIC not supported");
    });
    const original = photo("p1", "front");
    const [r] = await commitClusters(
      [
        {
          clusterId: "c1",
          label: "Item 1",
          linkItemId: null,
          photos: [original, photo("p2", "back")],
        },
      ],
      OWNER,
      null,
    );
    expect(uploads.some((u) => u.body === original.file)).toBe(false);
    expect(uploads.every((u) => !(u.body instanceof File))).toBe(true);
    expect(r!.ok).toBe(false);
    expect(r!.detail).toContain("couldn't be converted (HEIC?)");
  });

  it("skips a photo whose re-encode comes back empty", async () => {
    compressImage.mockImplementation(async () => ({
      blob: new Blob([], { type: "image/webp" }),
      width: 0,
      height: 0,
    }));
    await commitClusters(
      [{ clusterId: "c1", label: "Item 1", linkItemId: null, photos: [photo("p1", "front")] }],
      OWNER,
      null,
    );
    expect(uploads).toHaveLength(0);
  });
});

describe("M7: partial failures", () => {
  // Uploads run four at a time, so a failure is keyed on the photo (the only
  // "label" photo here) rather than on the order uploads happen in.
  const fivePhotos = () =>
    ["front", "back", "label", "detail", "detail"].map((t, i) => photo(`p${i + 1}`, t));

  it("counts a throwing photo against the cluster and keeps the item id", async () => {
    uploadFailsOn = (_n, path) => path.includes("/label_") && !path.includes("/thumbs/");
    const [r] = await commitClusters(
      [{ clusterId: "c1", label: "Item 3", linkItemId: null, photos: fivePhotos() }],
      OWNER,
      null,
    );
    expect(r!.ok).toBe(false);
    expect(r!.itemId).toBe("item-new");
    expect(r!.saved).toBe(4);
    expect(r!.failed).toBe(1);
    expect(r!.savedPhotoIds).toEqual(["p1", "p2", "p4", "p5"]);
    expect(r!.detail).toMatch(/^4 of 5 photos saved/);
  });

  it("does not advance the item when the front photo was skipped", async () => {
    compressImage.mockImplementation(async (f: File) => {
      if (f.name === "p1.jpg") throw new Error("HEIC");
      return { blob: new Blob([new Uint8Array([9])], { type: "image/webp" }), width: 1, height: 1 };
    });
    await commitClusters(
      [{ clusterId: "c1", label: "Item 1", linkItemId: null, photos: fivePhotos() }],
      OWNER,
      null,
    );
    expect(advanceItemStatus).not.toHaveBeenCalled();
  });

  it("advances when every required photo saved", async () => {
    await commitClusters(
      [{ clusterId: "c1", label: "Item 1", linkItemId: null, photos: fivePhotos() }],
      OWNER,
      null,
    );
    expect(advanceItemStatus).toHaveBeenCalledTimes(1);
  });

  it("counts a linked item's existing photos toward the required set", async () => {
    linkedRow = { id: "item-1", user_id: OWNER, status: "cataloged", photo_count: 0 };
    existingPhotoTypes = ["front", "back"];
    await commitClusters(
      [
        {
          clusterId: "c1",
          label: "Item 1",
          linkItemId: "item-1",
          photos: [photo("p1", "label"), photo("p2", "detail")],
        },
      ],
      OWNER,
      null,
    );
    expect(advanceItemStatus).toHaveBeenCalledTimes(1);
  });

  it("removes the storage object when the item_photos insert fails", async () => {
    photoInsertError = { message: "insert refused" };
    const [r] = await commitClusters(
      [{ clusterId: "c1", label: "Item 1", linkItemId: null, photos: [photo("p1", "front")] }],
      OWNER,
      null,
    );
    const mainPath = uploads[0]!.path;
    expect(removed.flat()).toContain(mainPath);
    expect(r!.ok).toBe(false);
  });
});

describe("M8: retrying a partial commit", () => {
  it("adds the leftovers to the item the first try created", async () => {
    linkedRow = { id: "item-prev", user_id: OWNER, status: "cataloged", photo_count: 4 };
    const [r] = await commitClusters(
      [
        {
          clusterId: "c1",
          label: "Item 3",
          linkItemId: null,
          resumeItemId: "item-prev",
          photos: [photo("p3", "label")],
        },
      ],
      OWNER,
      null,
    );
    expect(r!.ok).toBe(true);
    expect(r!.itemId).toBe("item-prev");
    expect(calls.some((c) => c.table === "inventory_items" && c.op === "insert")).toBe(false);
    // Sort order continues after the four photos already there.
    const photoRow = calls.find((c) => c.table === "item_photos" && c.op === "insert");
    expect((photoRow!.payload as { sort_order: number }).sort_order).toBe(4);
  });

  it("refuses to resume into another workspace's item", async () => {
    linkedRow = { id: "item-prev", user_id: OTHER, status: "cataloged", photo_count: 4 };
    const [r] = await commitClusters(
      [
        {
          clusterId: "c1",
          label: "Item 3",
          linkItemId: null,
          resumeItemId: "item-prev",
          photos: [photo("p3", "label")],
        },
      ],
      OWNER,
      null,
    );
    expect(r!.ok).toBe(false);
    expect(r!.detail).toContain("different workspace");
    expect(uploads).toHaveLength(0);
  });

  it("leaves the session open when unsorted photos stay on the board", async () => {
    await commitClusters(
      [{ clusterId: "c1", label: "Item 1", linkItemId: null, photos: [photo("p1", "front")] }],
      OWNER,
      "sess-1",
      { keepSessionOpen: true },
    );
    expect(calls.some((c) => c.table === "flipdesk_reconcile_sessions")).toBe(false);
  });

  it("closes the session when everything went through", async () => {
    await commitClusters(
      [{ clusterId: "c1", label: "Item 1", linkItemId: null, photos: [photo("p1", "front")] }],
      OWNER,
      "sess-1",
    );
    const close = calls.find((c) => c.table === "flipdesk_reconcile_sessions");
    expect(close?.payload).toEqual({ status: "committed" });
  });
});

describe("M12: progress", () => {
  it("reports every photo and item as it goes", async () => {
    const seen: Array<{ photosDone: number; item: number }> = [];
    await commitClusters(
      [
        { clusterId: "c1", label: "Item 1", linkItemId: null, photos: [photo("p1", "front"), photo("p2", "back")] },
        { clusterId: "c2", label: "Item 2", linkItemId: null, photos: [photo("p3", "front")] },
      ],
      OWNER,
      null,
      { onProgress: (p) => seen.push({ photosDone: p.photosDone, item: p.item }) },
    );
    const last = seen[seen.length - 1]!;
    expect(last).toEqual({ photosDone: 3, item: 2 });
    expect(seen.some((p) => p.item === 1 && p.photosDone === 0)).toBe(true);
  });

  it("keeps sort_order from each photo's place in the group", async () => {
    await commitClusters(
      [
        {
          clusterId: "c1",
          label: "Item 1",
          linkItemId: null,
          photos: ["front", "back", "label", "detail", "detail", "detail"].map((t, i) =>
            photo(`p${i + 1}`, t),
          ),
        },
      ],
      OWNER,
      null,
    );
    const orders = calls
      .filter((c) => c.table === "item_photos" && c.op === "insert")
      .map((c) => (c.payload as { sort_order: number }).sort_order)
      .sort((a, b) => a - b);
    expect(orders).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
