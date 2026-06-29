import { describe, expect, it } from "vitest";
import { isHeicFile, isVideoFile, MediaIntakeError } from "./media-intake";

function fileWith(name: string, type: string): File {
  return new File([new Uint8Array([0])], name, { type });
}

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
    // A real JPEG that happens to be named like a video must NOT be re-routed.
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
