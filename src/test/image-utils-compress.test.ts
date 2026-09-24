import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compressImage, scaledDimensions } from "@/lib/image-utils";

// SNAP-08: the long edge is capped, and a browser that silently returns PNG
// for a WebP request (Safari) gets a JPEG instead of a multi-MB upload.

let natural = { w: 1080, h: 8000 };
let blobTypeFor: (requested: string) => string = (t) => t;
const toBlobCalls: string[] = [];
const drawn: Array<[number, number]> = [];

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = natural.w;
  naturalHeight = natural.h;
  set src(_v: string) {
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  toBlobCalls.length = 0;
  drawn.length = 0;
  vi.stubGlobal("Image", FakeImage);
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return {
      drawImage: () => drawn.push([this.width, this.height]),
      getImageData: () => ({ data: new Uint8ClampedArray(9 * 8 * 4) }),
    } as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (cb: BlobCallback, type?: string) => {
      toBlobCalls.push(type ?? "");
      cb(new Blob(["x"], { type: blobTypeFor(type ?? "") }));
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  natural = { w: 1080, h: 8000 };
  blobTypeFor = (t) => t;
});

const file = (type = "image/jpeg", name = "a.jpg") => new File(["x"], name, { type });

describe("scaledDimensions", () => {
  it("caps the long edge, portrait or landscape", () => {
    expect(scaledDimensions(1080, 8000, { maxEdge: 1600 })).toEqual({ width: 216, height: 1600 });
    expect(scaledDimensions(8000, 1080, { maxEdge: 1600 })).toEqual({ width: 1600, height: 216 });
    expect(scaledDimensions(800, 600, { maxEdge: 1600 })).toEqual({ width: 800, height: 600 });
  });

  it("keeps the width-only cap for existing callers", () => {
    expect(scaledDimensions(1080, 8000, { maxWidth: 2400 })).toEqual({ width: 1080, height: 8000 });
    expect(scaledDimensions(4800, 1000, { maxWidth: 2400 })).toEqual({ width: 2400, height: 500 });
  });
});

describe("compressImage (SNAP-08)", () => {
  it("a 1080x8000 input comes out at most 1600 on its long edge", async () => {
    const r = await compressImage(file(), { maxEdge: 1600, quality: 0.82, outputType: "image/jpeg" });
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(1600);
    expect(r.height).toBe(1600);
    expect(r.blob.type).toBe("image/jpeg");
  });

  it("re-encodes as JPEG when WebP comes back as PNG", async () => {
    blobTypeFor = (t) => (t === "image/webp" ? "image/png" : t);
    const r = await compressImage(file(), 2400, 0.85);
    expect(toBlobCalls).toEqual(["image/webp", "image/jpeg"]);
    expect(r.blob.type).toBe("image/jpeg");
  });

  it("leaves a supported WebP alone, and the positional signature still works", async () => {
    natural = { w: 4800, h: 1000 };
    const r = await compressImage(file(), 2400, 0.85);
    expect(toBlobCalls).toEqual(["image/webp"]);
    expect(r.blob.type).toBe("image/webp");
    expect(r.width).toBe(2400);
  });
});
