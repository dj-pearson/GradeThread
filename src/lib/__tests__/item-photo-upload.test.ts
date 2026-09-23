import { beforeEach, describe, expect, it, vi } from "vitest";

// flipdesk-inventory plan, action 2. item-photos is the one PUBLIC bucket and
// the browser writes to it directly, so the canvas re-encode in compressImage
// is the only thing that strips EXIF/GPS on this path. When it failed, the
// core used to upload the untouched camera original. And when the item_photos
// insert failed, the objects it had just uploaded were left with no row.

const h = vi.hoisted(() => ({
  uploads: [] as Array<{ path: string; body: unknown }>,
  removed: [] as string[][],
  insertError: null as unknown,
  uploadError: null as unknown,
  inserted: [] as Array<Record<string, unknown>>,
  compress: vi.fn(),
}));

vi.mock("@/lib/supabase", () => {
  const bucket = {
    upload: async (path: string, body: unknown) => {
      h.uploads.push({ path, body });
      return { data: { path }, error: h.uploadError };
    },
    getPublicUrl: (path: string) => ({
      data: { publicUrl: `https://cdn.example/${path}` },
    }),
    remove: async (paths: string[]) => {
      h.removed.push(paths);
      return { data: [], error: null };
    },
  };
  return {
    supabase: {
      storage: { from: () => bucket },
      from: () => ({
        insert: async (row: Record<string, unknown>) => {
          h.inserted.push(row);
          return { data: null, error: h.insertError };
        },
      }),
    },
  };
});

vi.mock("@/lib/image-utils", () => ({ compressImage: h.compress }));

vi.mock("@/lib/media-intake", () => ({
  normalizeToImageFile: async (f: File) => f,
}));

vi.mock("@/lib/macro-photo-quality", () => ({
  assessMacroPhoto: () => ({ message: null }),
  measureMacroPhoto: async () => null,
  uploadMaxWidthFor: () => 2400,
}));

import { uploadItemPhoto } from "@/lib/item-photo-upload";

function original(): File {
  return new File([new Uint8Array([0xff, 0xd8, 1, 2, 3])], "IMG_0001.jpg", {
    type: "image/jpeg",
  });
}

const baseInput = {
  itemId: "item-1",
  ownerFolder: "owner-1",
  photoType: "front" as const,
  sortOrder: 0,
};

beforeEach(() => {
  h.uploads.length = 0;
  h.removed.length = 0;
  h.insertError = null;
  h.uploadError = null;
  h.inserted.length = 0;
  h.compress.mockReset();
});

describe("the camera original never reaches the public bucket", () => {
  it("compression throwing fails the upload and stores nothing", async () => {
    h.compress.mockRejectedValue(new Error("canvas decode failed"));
    const file = original();

    await expect(uploadItemPhoto({ ...baseInput, file })).rejects.toThrow(
      /Couldn't prepare IMG_0001\.jpg for upload/,
    );
    expect(h.uploads.some((u) => u.body === file)).toBe(false);
    expect(h.uploads).toHaveLength(0);
  });

  it("compression returning an empty blob fails the upload and stores nothing", async () => {
    h.compress.mockResolvedValue({
      blob: new Blob([], { type: "image/webp" }),
      width: 0,
      height: 0,
    });
    const file = original();

    await expect(uploadItemPhoto({ ...baseInput, file })).rejects.toThrow(
      /Couldn't prepare/,
    );
    expect(h.uploads).toHaveLength(0);
  });

  it("a good compress stores the re-encoded blob, not the original", async () => {
    const encoded = new Blob([new Uint8Array([9, 9, 9])], {
      type: "image/webp",
    });
    h.compress.mockResolvedValue({ blob: encoded, width: 10, height: 10 });

    await uploadItemPhoto({ ...baseInput, file: original() });
    expect(h.uploads.length).toBeGreaterThan(0);
    expect(h.uploads.every((u) => u.body === encoded)).toBe(true);
    expect(h.uploads[0]!.path).toMatch(/^owner-1\/item-1\/front_.*\.webp$/);
    expect(h.removed).toHaveLength(0);
  });
});

describe("a failed row insert removes what was just uploaded", () => {
  it("removes the photo and its thumbnail, then rethrows the insert error", async () => {
    const encoded = new Blob([new Uint8Array([9, 9, 9])], {
      type: "image/webp",
    });
    h.compress.mockResolvedValue({ blob: encoded, width: 10, height: 10 });
    const insErr = { message: "insert refused", code: "42501" };
    h.insertError = insErr;

    await expect(
      uploadItemPhoto({ ...baseInput, file: original() }),
    ).rejects.toBe(insErr);

    const uploadedPaths = h.uploads.map((u) => u.path);
    expect(uploadedPaths).toHaveLength(2); // full image + thumbnail
    expect(h.removed).toHaveLength(1);
    expect([...h.removed[0]!].sort()).toEqual([...uploadedPaths].sort());
  });
});

// The offline intake queue retries a photo on every flush. With a photoId the
// path and the row id are fixed, so a retry after a lost response finds its own
// upload rather than adding a second copy of the photo.
describe("a photoId makes a retry idempotent", () => {
  const PHOTO_ID = "11111111-2222-3333-4444-555555555555";
  function encodes() {
    h.compress.mockResolvedValue({
      blob: new Blob([new Uint8Array([9, 9, 9])], { type: "image/webp" }),
      width: 10,
      height: 10,
    });
  }

  it("derives the storage path and the row id from the photoId", async () => {
    encodes();
    await uploadItemPhoto({ ...baseInput, file: original(), photoId: PHOTO_ID });
    await uploadItemPhoto({ ...baseInput, file: original(), photoId: PHOTO_ID });
    expect(h.uploads.map((u) => u.path)).toEqual([
      `owner-1/item-1/front_${PHOTO_ID}.webp`,
      `owner-1/item-1/thumbs/front_${PHOTO_ID}.webp`,
      `owner-1/item-1/front_${PHOTO_ID}.webp`,
      `owner-1/item-1/thumbs/front_${PHOTO_ID}.webp`,
    ]);
    expect(h.inserted.map((r) => r.id)).toEqual([PHOTO_ID, PHOTO_ID]);
  });

  it("an object and a row left by an earlier attempt count as success, and are kept", async () => {
    encodes();
    h.uploadError = { statusCode: "409", message: "The resource already exists" };
    h.insertError = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "item_photos_pkey"',
    };
    await expect(
      uploadItemPhoto({ ...baseInput, file: original(), photoId: PHOTO_ID }),
    ).resolves.toMatchObject({ storedSize: 3 });
    expect(h.removed).toHaveLength(0);
  });

  it("without a photoId the same answers are still failures", async () => {
    encodes();
    h.uploadError = { statusCode: "409", message: "The resource already exists" };
    await expect(
      uploadItemPhoto({ ...baseInput, file: original() }),
    ).rejects.toMatchObject({ statusCode: "409" });
    expect(h.inserted).toHaveLength(0);
  });

  it("a unique violation on some other constraint is not taken as already done", async () => {
    encodes();
    h.insertError = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "something_else"',
    };
    await expect(
      uploadItemPhoto({ ...baseInput, file: original(), photoId: PHOTO_ID }),
    ).rejects.toBe(h.insertError);
    expect(h.removed).toHaveLength(1);
  });
});
