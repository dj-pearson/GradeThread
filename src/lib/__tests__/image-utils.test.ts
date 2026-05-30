import { describe, it, expect, vi, beforeEach } from "vitest";

// heic2any bundles a libheif wasm decoder that can't run under jsdom, so we mock
// the dynamic import. These tests guard the detection + fallback contract that
// US-326 relies on; the actual pixel decode is exercised in the browser.
const heic2anyMock = vi.fn();
vi.mock("heic2any", () => ({ default: (args: unknown) => heic2anyMock(args) }));

import { isHeicFile, decodeHeicToJpeg, normalizeImageFile } from "../image-utils";

function file(name: string, type: string, bytes = 4): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("isHeicFile", () => {
  it("detects HEIC/HEIF by MIME type", () => {
    expect(isHeicFile(file("a.jpg", "image/heic"))).toBe(true);
    expect(isHeicFile(file("a.jpg", "image/heif"))).toBe(true);
    expect(isHeicFile(file("a.jpg", "image/heic-sequence"))).toBe(true);
    expect(isHeicFile(file("a.jpg", "image/heif-sequence"))).toBe(true);
  });

  it("detects HEIC/HEIF by extension when MIME is empty (Safari)", () => {
    expect(isHeicFile(file("IMG_1234.HEIC", ""))).toBe(true);
    expect(isHeicFile(file("photo.heif", ""))).toBe(true);
    expect(isHeicFile(file("photo.heic", "application/octet-stream"))).toBe(true);
  });

  it("does not flag ordinary images", () => {
    expect(isHeicFile(file("a.jpg", "image/jpeg"))).toBe(false);
    expect(isHeicFile(file("a.png", "image/png"))).toBe(false);
    expect(isHeicFile(file("a.webp", "image/webp"))).toBe(false);
  });
});

describe("normalizeImageFile", () => {
  beforeEach(() => heic2anyMock.mockReset());

  it("passes non-HEIC files through untouched (no decode)", async () => {
    const jpg = file("a.jpg", "image/jpeg");
    const out = await normalizeImageFile(jpg);
    expect(out).toBe(jpg);
    expect(heic2anyMock).not.toHaveBeenCalled();
  });

  it("transcodes HEIC to a JPEG File with a .jpg name", async () => {
    heic2anyMock.mockResolvedValue(new Blob(["jpeg"], { type: "image/jpeg" }));
    const out = await normalizeImageFile(file("IMG_1234.HEIC", "image/heic"));
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("IMG_1234.jpg");
    expect(heic2anyMock).toHaveBeenCalledTimes(1);
  });
});

describe("decodeHeicToJpeg", () => {
  beforeEach(() => heic2anyMock.mockReset());

  it("takes the primary image when heic2any returns an array (multi-image HEIC)", async () => {
    heic2anyMock.mockResolvedValue([
      new Blob(["primary"], { type: "image/jpeg" }),
      new Blob(["secondary"], { type: "image/jpeg" }),
    ]);
    const out = await decodeHeicToJpeg(file("burst.heic", "image/heic"));
    expect(out.type).toBe("image/jpeg");
    expect(await out.text()).toBe("primary");
  });

  it("throws when the decode produces no image data", async () => {
    heic2anyMock.mockResolvedValue([]);
    await expect(decodeHeicToJpeg(file("bad.heic", "image/heic"))).rejects.toThrow(
      /no image data/i,
    );
  });
});
