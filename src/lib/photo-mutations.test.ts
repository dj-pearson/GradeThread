import { describe, it, expect, vi } from "vitest";
import {
  persistDelete,
  persistPhotoEdit,
  revertPhotoEdit,
  type PhotoEditClient,
} from "./photo-mutations";
import { buildEditRecipe } from "./photo-edit-recipe";
import { NEUTRAL_ADJUSTMENTS } from "./image-adjustments";
import type { RotatableCalibration } from "./measure-photo-geometry";

/** The stored calibration shape, narrowed for the assertions below. */
type StoredCal = RotatableCalibration & {
  lines: Record<string, { e1: [number, number]; e2: [number, number] }>;
};

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
    // US-2407: which bucket each storage call was routed to.
    buckets: [] as string[],
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
    storage: {
      from: (bucket: string) => {
        calls.buckets.push(bucket);
        return store;
      },
    },
  } as unknown as PhotoEditClient;
  return { client, calls, store };
}

const PHOTO = {
  id: "photo-1",
  storage_path: "user-1/item-1/front_1.jpg",
  thumbnail_storage_path: "user-1/item-1/thumbs/front_1.jpg",
  original_storage_path: null,
  photo_url: "https://cdn.test/user-1/item-1/front_1.jpg",
};

// A phone-captured Garment Tag: bytes in the PRIVATE bucket, photo_url "".
const PRIVATE_TAG = {
  id: "photo-9",
  storage_path: "user-1/item-1/tag_1.jpg",
  thumbnail_storage_path: null,
  original_storage_path: null,
  photo_url: "",
};

describe("persistPhotoEdit", () => {
  it("preserves the original before overwriting, on the first edit", () => {
    const { client, calls } = makeClient();
    return persistPhotoEdit(client, PHOTO, new Blob(["edited"]), RECIPE, { now: 999 }).then(
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
    await persistPhotoEdit(client, PHOTO, new Blob(["e"]), RECIPE, { now: 4242 });
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

  // US-2407: the report was "in Composer the Garment Tags all can't be edited —
  // the pencil is greyed out". The block was real, but the reason underneath it
  // was that this function wrote every edit to the PUBLIC bucket, so a private
  // photo's preserve-the-original copy() could only 404. It now writes back to
  // the bucket the bytes came from, which makes the edit safe rather than banned.
  describe("a private-bucket photo (phone-captured tag)", () => {
    it("reads and writes the private bucket, never item-photos", async () => {
      const { client, calls } = makeClient();
      await persistPhotoEdit(client, PRIVATE_TAG, new Blob(["e"]), RECIPE);
      expect(new Set(calls.buckets)).toEqual(new Set(["submission-images"]));
      expect(calls.copy).toEqual([
        ["user-1/item-1/tag_1.jpg", "user-1/item-1/originals/tag_1.jpg"],
      ]);
      expect(calls.upload[0]![0]).toBe("user-1/item-1/tag_1.jpg");
    });

    it("leaves photo_url empty — the edit publishes nothing", async () => {
      // An edited private photo that acquired a public URL would be pushed to
      // eBay by every downstream resolver. Not writing the column is what keeps
      // the PII the private bucket exists to hold out of the listing.
      const { client, calls } = makeClient();
      await persistPhotoEdit(client, PRIVATE_TAG, new Blob(["e"]), RECIPE, { now: 4242 });
      expect(calls.update[0]).not.toHaveProperty("photo_url");
      expect(calls.update[0]!.edit_recipe).toEqual(RECIPE);
    });

    it("reverts within the private bucket too", async () => {
      const { client, calls } = makeClient();
      await revertPhotoEdit(
        client,
        { ...PRIVATE_TAG, original_storage_path: "user-1/item-1/originals/tag_1.jpg" },
        77,
      );
      expect(new Set(calls.buckets)).toEqual(new Set(["submission-images"]));
      expect(calls.update[0]).not.toHaveProperty("photo_url");
    });
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
      photo_url: "https://cdn.test/user-1/item-1/front_1.jpg",
    });
    expect(calls.remove[0]).toEqual([
      "user-1/item-1/front_1.jpg",
      "user-1/item-1/originals/front_1.jpg",
    ]);
    expect(calls.buckets).toEqual(["item-photos"]);
    expect(calls.deleted).toEqual(["photo-1"]);
  });

  it("still works for a never-edited photo", async () => {
    const { client, calls } = makeClient();
    await persistDelete(client, {
      id: "photo-2",
      storage_path: "user-1/item-1/back_1.jpg",
      original_storage_path: null,
      photo_url: "https://cdn.test/user-1/item-1/back_1.jpg",
    });
    expect(calls.remove[0]).toEqual(["user-1/item-1/back_1.jpg"]);
  });

  it("deletes a private photo's object from the private bucket", async () => {
    // US-2407: this used to say `.from("item-photos")` unconditionally, so
    // deleting a phone-captured tag removed the ROW and left the object behind —
    // orphaned in the private bucket, unreachable from the UI, still holding the
    // names and addresses a care label can carry.
    const { client, calls } = makeClient();
    await persistDelete(client, {
      id: "photo-9",
      storage_path: "user-1/item-1/tag_1.jpg",
      original_storage_path: null,
      photo_url: "",
    });
    expect(calls.buckets).toEqual(["submission-images"]);
    expect(calls.remove[0]).toEqual(["user-1/item-1/tag_1.jpg"]);
  });

  it("deletes the row even when there is no file to remove", async () => {
    const { client, calls } = makeClient();
    await persistDelete(client, {
      id: "photo-3",
      storage_path: null,
      photo_url: "",
    });
    expect(calls.remove).toEqual([]);
    expect(calls.deleted).toEqual(["photo-3"]);
  });
});

// US-2888: a photo carrying a MeasureCard calibration. 4000x3000, one chest
// line running across the middle.
const CALIBRATED = {
  ...PHOTO,
  id: "photo-cal",
  width: 4000,
  height: 3000,
  edit_recipe: null,
  measure_calibration: {
    v: 1,
    ppi: 100,
    homography: [0.01, 0, -0.5, 0, 0.01, -0.6, 0, 0, 1],
    lines: {
      chest: {
        e1: [400, 900] as [number, number],
        e2: [2400, 900] as [number, number],
        inches: 20,
        label: "Chest (in)",
      },
    },
  },
};

describe("persistPhotoEdit and the MeasureCard calibration (US-2888)", () => {
  const ROTATE_90 = buildEditRecipe({
    rotation: 90,
    fine: 0,
    crop: null,
    aspect: null,
    adjustments: NEUTRAL_ADJUSTMENTS,
    bgRemoved: false,
    editedAt: "2026-08-25T00:00:00.000Z",
  });

  it("leaves an uncalibrated photo entirely alone", async () => {
    const { client, calls } = makeClient();
    const outcome = await persistPhotoEdit(client, PHOTO, new Blob(["e"]), ROTATE_90);
    expect(outcome).toEqual({ action: "keep" });
    expect(calls.update[0]).not.toHaveProperty("measure_calibration");
  });

  it("turns the lines and the homography with the photo, and says so", async () => {
    const { client, calls } = makeClient();
    const outcome = await persistPhotoEdit(
      client,
      CALIBRATED,
      new Blob(["e"]),
      ROTATE_90,
      { dims: [3000, 4000] },
    );
    expect(outcome.action).toBe("rotate");
    const written = (calls.update[0]! as { measure_calibration: StoredCal })
      .measure_calibration;
    // (x, y) -> (h - y, x) at 4000x3000.
    expect(written.lines.chest!.e1).toEqual([2100, 400]);
    expect(written.lines.chest!.e2).toEqual([2100, 2400]);
    // Both endpoints are inside the ROTATED frame, which is the whole point:
    // 2400 used to be a legal x in a 4000-wide photo and would now be past the
    // right edge of a 3000-wide one.
    for (const p of [written.lines.chest!.e1, written.lines.chest!.e2]) {
      expect(p[0]).toBeLessThanOrEqual(3000);
      expect(p[1]).toBeLessThanOrEqual(4000);
    }
    expect(written.ppi).toBe(100);
  });

  it("writes the new dimensions, which no edit used to do", async () => {
    const { client, calls } = makeClient();
    await persistPhotoEdit(client, CALIBRATED, new Blob(["e"]), ROTATE_90, {
      dims: [3000, 4000],
    });
    expect(calls.update[0]!.width).toBe(3000);
    expect(calls.update[0]!.height).toBe(4000);
  });

  it("clears the calibration for a crop rather than pretending it still fits", async () => {
    const { client, calls } = makeClient();
    const cropped = buildEditRecipe({
      rotation: 0,
      fine: 0,
      crop: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 },
      aspect: null,
      adjustments: NEUTRAL_ADJUSTMENTS,
      bgRemoved: false,
      editedAt: "2026-08-25T00:00:00.000Z",
    });
    const outcome = await persistPhotoEdit(client, CALIBRATED, new Blob(["e"]), cropped, {
      dims: [2400, 1800],
    });
    expect(outcome).toEqual({ action: "clear", reason: "resampled" });
    expect(calls.update[0]!.measure_calibration).toBeNull();
  });

  it("keeps the calibration through a tone-only edit", async () => {
    const { client, calls } = makeClient();
    const toned = buildEditRecipe({
      rotation: 0,
      fine: 0,
      crop: null,
      aspect: null,
      adjustments: { ...NEUTRAL_ADJUSTMENTS, brightness: 15 },
      bgRemoved: false,
      editedAt: "2026-08-25T00:00:00.000Z",
    });
    const outcome = await persistPhotoEdit(client, CALIBRATED, new Blob(["e"]), toned, {
      dims: [4000, 3000],
    });
    expect(outcome).toEqual({ action: "keep" });
    expect(calls.update[0]).not.toHaveProperty("measure_calibration");
  });

  it("reads the turn as the DIFFERENCE between recipes, not the new one", async () => {
    // Recipes are absolute against the preserved original. A photo already at
    // 270 that is saved at 0 has turned one quarter clockwise, not three.
    const { client, calls } = makeClient();
    const from270 = {
      ...CALIBRATED,
      edit_recipe: buildEditRecipe({
        rotation: 270,
        fine: 0,
        crop: null,
        aspect: null,
        adjustments: NEUTRAL_ADJUSTMENTS,
        bgRemoved: false,
        editedAt: "2026-08-24T00:00:00.000Z",
      }),
    };
    const to0 = buildEditRecipe({
      rotation: 0,
      fine: 0,
      crop: null,
      aspect: null,
      adjustments: NEUTRAL_ADJUSTMENTS,
      bgRemoved: false,
      editedAt: "2026-08-25T00:00:00.000Z",
    });
    const outcome = await persistPhotoEdit(client, from270, new Blob(["e"]), to0, {
      dims: [3000, 4000],
    });
    expect(outcome).toMatchObject({ action: "rotate", turns: 1 });
    expect(
      (calls.update[0]! as { measure_calibration: StoredCal }).measure_calibration
        .lines.chest!.e1,
    ).toEqual([2100, 400]);
  });

  it("clears rather than guesses when the stored dimensions are missing", async () => {
    const { client, calls } = makeClient();
    const outcome = await persistPhotoEdit(
      client,
      { ...CALIBRATED, width: null, height: null },
      new Blob(["e"]),
      ROTATE_90,
    );
    expect(outcome).toEqual({ action: "clear", reason: "unknown-dimensions" });
    expect(calls.update[0]!.measure_calibration).toBeNull();
  });
});
