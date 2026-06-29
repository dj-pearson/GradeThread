import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractVideoFrame,
  isHeicFile,
  isVideoFile,
  MediaIntakeError,
  normalizeToImageFile,
  transcodeHeic,
} from "./media-intake";

// The HEIC decoder is a 3MB WASM module; mock it so the unit test exercises our
// wrapper/routing logic without loading it. The factory is hoisted, so it may
// only reference globals (Blob/File exist under jsdom).
vi.mock("heic-to/csp", () => ({
  heicTo: vi.fn(async ({ blob }: { blob: File }) => {
    if (blob.name === "fail.heic") throw new Error("decode failed");
    return new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
  }),
}));

function fileWith(name: string, type: string, bytes = 1): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

// ── DOM doubles for <video>/<canvas> (jsdom decodes neither) ─────────────────

interface FakeVideoOpts {
  duration?: number;
  width?: number;
  height?: number;
  fireError?: boolean;
  rvfc?: boolean;
}

function installVideoCanvasMocks(vopts: FakeVideoOpts, blob: Blob | null) {
  const video = {
    muted: false,
    playsInline: false,
    preload: "",
    src: "",
    currentTime: 0,
    duration: vopts.duration ?? 3,
    videoWidth: vopts.width ?? 1920,
    videoHeight: vopts.height ?? 1080,
    addEventListener(type: string, cb: () => void) {
      // Fire the relevant event on the next microtask so the awaiting code in
      // extractVideoFrame proceeds (or rejects, for the error case).
      if (vopts.fireError) {
        if (type === "error") queueMicrotask(cb);
        return;
      }
      if (type === "loadedmetadata" || type === "seeked") queueMicrotask(cb);
    },
    removeEventListener() {},
    removeAttribute() {},
    load() {},
  } as Record<string, unknown>;
  if (vopts.rvfc) {
    video.requestVideoFrameCallback = (cb: () => void) => {
      queueMicrotask(cb);
      return 1;
    };
  }

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob: (cb: (b: Blob | null) => void) => cb(blob),
  };

  const orig = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    if (tag === "video") return video as unknown as HTMLElement;
    if (tag === "canvas") return canvas as unknown as HTMLElement;
    return orig(tag);
  });
  // jsdom's object-URL helpers are noisy/absent — stub them.
  URL.createObjectURL = vi.fn(() => "blob:fake");
  URL.revokeObjectURL = vi.fn();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isVideoFile", () => {
  it("detects iPhone Live Photo videos by MIME", () => {
    expect(isVideoFile(fileWith("IMG_0001.mov", "video/quicktime"))).toBe(true);
    expect(isVideoFile(fileWith("clip.mp4", "video/mp4"))).toBe(true);
  });

  it("falls back to extension when the type is empty (dragged .mov)", () => {
    expect(isVideoFile(fileWith("IMG_0001.MOV", ""))).toBe(true);
    expect(isVideoFile(fileWith("video.m4v", ""))).toBe(true);
  });

  it("treats a non-empty non-video MIME as authoritative", () => {
    expect(isVideoFile(fileWith("weird.mov", "image/jpeg"))).toBe(false);
  });

  it("ignores ordinary images", () => {
    expect(isVideoFile(fileWith("front.jpg", "image/jpeg"))).toBe(false);
    expect(isVideoFile(fileWith("front.png", "image/png"))).toBe(false);
  });
});

describe("isHeicFile", () => {
  it("detects HEIC/HEIF by MIME", () => {
    expect(isHeicFile(fileWith("IMG.heic", "image/heic"))).toBe(true);
    expect(isHeicFile(fileWith("IMG.heif", "image/heif"))).toBe(true);
  });

  it("falls back to extension when the type is empty", () => {
    expect(isHeicFile(fileWith("IMG_2.HEIC", ""))).toBe(true);
  });

  it("ignores ordinary images", () => {
    expect(isHeicFile(fileWith("front.jpg", "image/jpeg"))).toBe(false);
  });
});

describe("MediaIntakeError", () => {
  it("carries the conversion kind", () => {
    expect(new MediaIntakeError("video", "x").kind).toBe("video");
    expect(new MediaIntakeError("heic", "y").kind).toBe("heic");
  });
});

describe("extractVideoFrame", () => {
  it("decodes a frame into a JPEG File and renames the extension", async () => {
    installVideoCanvasMocks(
      { rvfc: true },
      new Blob([new Uint8Array([9, 9, 9])], { type: "image/jpeg" }),
    );
    const out = await extractVideoFrame(fileWith("IMG_0001.mov", "video/quicktime"));
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("IMG_0001.jpg");
    expect(out.size).toBeGreaterThan(0);
  });

  it("works without requestVideoFrameCallback", async () => {
    installVideoCanvasMocks(
      { rvfc: false, duration: 0.1 }, // short clip → seek target 0 branch
      new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
    );
    const out = await extractVideoFrame(fileWith("clip.mp4", "video/mp4"));
    expect(out.name).toBe("clip.jpg");
  });

  it("rejects an oversized video before decoding", async () => {
    const big = fileWith("huge.mp4", "video/mp4");
    Object.defineProperty(big, "size", { value: 300 * 1024 * 1024 });
    await expect(extractVideoFrame(big)).rejects.toMatchObject({
      kind: "video",
    });
  });

  it("throws when the video has no readable frame", async () => {
    installVideoCanvasMocks({ width: 0, height: 0 }, new Blob([new Uint8Array([1])]));
    await expect(
      extractVideoFrame(fileWith("bad.mov", "video/quicktime")),
    ).rejects.toMatchObject({ kind: "video" });
  });

  it("throws a video error when the element fails to load", async () => {
    installVideoCanvasMocks({ fireError: true }, null);
    await expect(
      extractVideoFrame(fileWith("broken.mov", "video/quicktime")),
    ).rejects.toMatchObject({ kind: "video" });
  });

  it("throws when the canvas yields no blob", async () => {
    installVideoCanvasMocks({}, null);
    await expect(
      extractVideoFrame(fileWith("empty.mov", "video/quicktime")),
    ).rejects.toMatchObject({ kind: "video" });
  });
});

describe("transcodeHeic", () => {
  it("converts HEIC to a JPEG File", async () => {
    const out = await transcodeHeic(fileWith("IMG.heic", "image/heic"));
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("IMG.jpg");
  });

  it("wraps a decoder failure as a heic MediaIntakeError", async () => {
    await expect(
      transcodeHeic(fileWith("fail.heic", "image/heic")),
    ).rejects.toMatchObject({ kind: "heic" });
  });
});

describe("normalizeToImageFile", () => {
  it("passes an ordinary image through untouched", async () => {
    const f = fileWith("front.jpg", "image/jpeg");
    expect(await normalizeToImageFile(f)).toBe(f);
  });

  it("routes a video to a still JPEG frame", async () => {
    installVideoCanvasMocks(
      {},
      new Blob([new Uint8Array([5])], { type: "image/jpeg" }),
    );
    const out = await normalizeToImageFile(fileWith("live.mov", "video/quicktime"));
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("live.jpg");
  });

  it("routes a HEIC file through the decoder", async () => {
    const out = await normalizeToImageFile(fileWith("photo.heic", "image/heic"));
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("photo.jpg");
  });
});
