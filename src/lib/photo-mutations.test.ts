import { describe, it, expect, vi } from "vitest";
import {
  persistDelete,
  persistPhotoEdit,
  revertPhotoEdit,
  type PhotoEditClient,
} from "./photo-mutations";
import { buildEditRecipe } from "./photo-edit-recipe";
import { NEUTRAL_ADJUSTMENTS } from "./image-adjustments";

const RECIPE = buildEditRecipe({
  rotation: 90,
  fine: 0,
  crop: null,
  aspect: null,
  adjustments: { ...NEUTRAL_ADJUSTMENTS, brightness: 12 },
  bgRemoved: false,
  editedAt: "2026-07-27T00:00:00.000Z",
});

/** Recording stub for the storage + table surface the edit path touches. */
function makeClient(
  overrides: {
    copyError?: unknown;
    uploadError?: unknown;
    downloadError?: unknown;
    downloadData?: Blob | null;
    updateError?: unknown;
  } = {},
) {
  const calls = {
    copy: [] as [string, string][],
    upload: [] as [string, Blob][],
    remove: [] as string[][],
    download: [] as string[],
    update: [] as Record<string, unknown>[],
    deleted: [] as string[],
  };
  const store = {
    copy: vi.fn((from: string, to: string) => {
      calls.copy.push([from, to]);
      return Promise.resolve({ error: overrides.copyError ?? null });
    }),
    upload: vi.fn((path: string, body: Blob) => {
      calls.upload.push([path, body]);
      return Promise.resolve({ error: overrides.uploadError ?? null });
    }),
    remove: vi.fn((paths: string[]) => {
      calls.remove.push(paths);
      return Promise.resolve({});
    }),
    download: vi.fn((path: string) => {
      calls.download.push(path);
      return Promise.resolve({
        data:
          overrides.downloadData !== undefined
            ? overrides.downloadData
            : new Blob(["original"]),
        error: overrides.downloadError ?? null,
      });
    }),
    getPublicUrl: (path: string) => ({
      data: { publicUrl: `https://cdn.test/${path}` },
    }),
  };
  const client = {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        calls.update.push(patch);
        return {
          eq: () => Promise.resolve({ error: overrides.updateError ?? null }),
        };
      },
      delete: () => ({
        eq: (_c: string, id: string) => {
          calls.deleted.push(id);
          return Promise.resolve({ error: null });
        },
      }),
    }),
    storage: { from: () => store },
  } as unknown as PhotoEditClient;
  return { client, calls, store };
}

const PHOTO = {
  id: "photo-1",
  storage_path: "user-1/item-1/front_1.jpg",
  thumbnail_storage_path: "user-1/item-1/thumbs/front_1.jpg",
  original_storage_path: null,
};

describe("persistPhotoEdit", () => {
  it("preserves the original before overwriting, on the first edit", () => {
    const { client, calls } = makeClient();
    return persistPhotoEdit(client, PHOTO, new Blob(["edited"]), RECIPE, 999).then(
      () => {
        expect(calls.copy).toEqual([
          ["user-1/item-1/front_1.jpg", "user-1/item-1/originals/front_1.jpg"],
        ]);
        expect(calls.update[0]!.original_storage_path).toBe(
          "user-1/item-1/originals/front_1.jpg",
        );
      },
    );
  });

  it("copies BEFORE uploading, never after", async () => {
    // Ordering is the whole safety property: an upload that lands first has
    // already destroyed the bytes the copy was meant to preserve.
    const order: string[] = [];
    const { client, store } = makeClient();
    store.copy.mockImplementation(() => {
      order.push("copy");
      return Promise.resolve({ error: null });
    });
    store.upload.mockImplementation(() => {
      order.push("upload");
      return Promise.resolve({ error: null });
    });
    await persistPhotoEdit(client, PHOTO, new Blob(["e"]), RECIPE);
    expect(order).toEqual(["copy", "upload"]);
  });

  it("does NOT re-copy when an original is already preserved", async () => {
    const { client, calls } = makeClient();
    await persistPhotoEdit(
      client,
      { ...PHOTO, original_storage_path: "user-1/item-1/originals/front_1.jpg" },
      new Blob(["edited again"]),
      RECIPE,
    );
    // A second copy would overwrite the true original with the FIRST edit,
    // making "revert to original" a lie.
    expect(calls.copy).toEqual([]);
    expect(calls.update[0]!.original_storage_path).toBe(
      "user-1/item-1/originals/front_1.jpg",
    );
  });

  it("aborts the whole edit when the original can't be preserved", async () => {
    const { client, calls } = makeClient({ copyError: new Error("quota") });
    await expect(
      persistPhotoEdit(client, PHOTO, new Blob(["edited"]), RECIPE),
    ).rejects.toThrow(/preserve the original/i);
    expect(calls.upload).toEqual([]); // the original is still intact
    expect(calls.update).toEqual([]);
  });

  it("busts the cached url and drops the stale thumbnail", async () => {
    const { client, calls } = makeClient();
    await persistPhotoEdit(client, PHOTO, new Blob(["e"]), RECIPE, 4242);
    expect(calls.update[0]!.photo_url).toBe(
      "https://cdn.test/user-1/item-1/front_1.jpg?v=4242",
    );
    expect(calls.update[0]!.thumbnail_url).toBeNull();
    expect(calls.update[0]!.thumbnail_storage_path).toBeNull();
    expect(calls.remove).toEqual([["user-1/item-1/thumbs/front_1.jpg"]]);
  });

  it("records the recipe", async () => {
    const { client, calls } = makeClient();
    await persistPhotoEdit(client, PHOTO, new Blob(["e"]), RECIPE);
    expect(calls.update[0]!.edit_recipe).toEqual(RECIPE);
  });

  it("rejects a photo with no storage path", async () => {
    const { client } = makeClient();
    await expect(
      persistPhotoEdit(
        client,
        { ...PHOTO, storage_path: null },
        new Blob(["e"]),
        RECIPE,
      ),
    ).rejects.toThrow(/storage path/i);
  });

  it("propagates an upload failure instead of writing the row", async () => {
    const { client, calls } = makeClient({ uploadError: new Error("nope") });
    await expect(
      persistPhotoEdit(client, PHOTO, new Blob(["e"]), RECIPE),
    ).rejects.toThrow();
    expect(calls.update).toEqual([]);
  });
});

describe("revertPhotoEdit", () => {
  const EDITED = {
    ...PHOTO,
    original_storage_path: "user-1/item-1/originals/front_1.jpg",
  };

  it("restores the original over the working path and clears the recipe", async () => {
    const { client, calls } = makeClient();
    await revertPhotoEdit(client, EDITED, 77);
    expect(calls.download).toEqual(["user-1/item-1/originals/front_1.jpg"]);
    expect(calls.upload[0]![0]).toBe("user-1/item-1/front_1.jpg");
    expect(calls.update[0]!.edit_recipe).toBeNull();
    expect(calls.update[0]!.photo_url).toBe(
      "https://cdn.test/user-1/item-1/front_1.jpg?v=77",
    );
  });

  it("KEEPS original_storage_path so a later edit doesn't copy a second original", async () => {
    const { client, calls } = makeClient();
    await revertPhotoEdit(client, EDITED);
    expect(calls.update[0]).not.toHaveProperty("original_storage_path");
  });

  it("changes nothing when the original can't be read", async () => {
    const { client, calls } = makeClient({ downloadError: new Error("404") });
    await expect(revertPhotoEdit(client, EDITED)).rejects.toThrow(
      /couldn't read the original/i,
    );
    expect(calls.upload).toEqual([]);
    expect(calls.update).toEqual([]);
  });

  it("treats an empty download body as a failure", async () => {
    const { client, calls } = makeClient({ downloadData: null });
    await expect(revertPhotoEdit(client, EDITED)).rejects.toThrow();
    expect(calls.upload).toEqual([]);
  });

  it("refuses when no original was ever preserved", async () => {
    const { client } = makeClient();
    await expect(revertPhotoEdit(client, PHOTO)).rejects.toThrow(
      /no preserved original/i,
    );
  });
});

describe("persistDelete", () => {
  it("removes the preserved original alongside the working file", async () => {
    const { client, calls } = makeClient();
    await persistDelete(client, {
      id: "photo-1",
      storage_path: "user-1/item-1/front_1.jpg",
      original_storage_path: "user-1/item-1/originals/front_1.jpg",
    });
    expect(calls.remove[0]).toEqual([
      "user-1/item-1/front_1.jpg",
      "user-1/item-1/originals/front_1.jpg",
    ]);
    expect(calls.deleted).toEqual(["photo-1"]);
  });

  it("still works for a never-edited photo", async () => {
    const { client, calls } = makeClient();
    await persistDelete(client, {
      id: "photo-2",
      storage_path: "user-1/item-1/back_1.jpg",
      original_storage_path: null,
    });
    expect(calls.remove[0]).toEqual(["user-1/item-1/back_1.jpg"]);
  });

  it("deletes the row even when there is no file to remove", async () => {
    const { client, calls } = makeClient();
    await persistDelete(client, { id: "photo-3", storage_path: null });
    expect(calls.remove).toEqual([]);
    expect(calls.deleted).toEqual(["photo-3"]);
  });
});
