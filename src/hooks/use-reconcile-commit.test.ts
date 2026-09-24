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
let uploadFailsOn: (n: number) => boolean = () => false;
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
          if (uploadFailsOn(uploadCount)) {
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
    expect(r.ok).toBe(true);
    expect(r.itemId).toBe("item-new");
  });
});
