import { describe, expect, it } from "vitest";
import { stagedSortName } from "./staged-sort-name";
import type { StagedPhoto } from "@/stores/autolister-upload-store";

// Extracted out of autolister.tsx by US-2450, which is when it gained a second
// caller: the grid already SORTED by this name, and now it SPEAKS it too. The
// sourceSig parsing is the part that can be quietly wrong, and a wrong answer
// there is a photo announcing a truncated filename rather than an obvious break.
const photo = (p: Partial<StagedPhoto>) => p as StagedPhoto;

describe("stagedSortName", () => {
  it("prefers the recorded source name", () => {
    expect(stagedSortName(photo({ sourceName: "IMG_9042.jpg" }))).toBe("IMG_9042.jpg");
  });

  it("recovers the filename from a pre-sourceName signature", () => {
    expect(stagedSortName(photo({ sourceSig: "IMG_9042.jpg|482133|1712345678" }))).toBe(
      "IMG_9042.jpg",
    );
  });

  it("keeps a pipe that is part of the filename", () => {
    // The signature is `name|size|mtime` and the NAME may contain a pipe, so the
    // two known trailing segments are stripped rather than parts[0] taken. Doing
    // it the other way truncates "front|back.jpg" to "front", which sorts and
    // speaks as a different photo.
    expect(stagedSortName(photo({ sourceSig: "front|back.jpg|1024|99" }))).toBe(
      "front|back.jpg",
    );
  });

  it("ignores a signature that is too short to carry a name", () => {
    expect(stagedSortName(photo({ sourceSig: "justaname" }))).toBeNull();
    expect(stagedSortName(photo({ sourceSig: "name|1024" }))).toBeNull();
  });

  it("returns null when nothing is known, rather than a stand-in", () => {
    // A Google Photos import has no filename. Returning a constant here would
    // give every photo in that import the same name, which is the defect the
    // caller's positional fallback exists to avoid — and it would hide it,
    // because the label would look derived.
    expect(stagedSortName(photo({}))).toBeNull();
  });

  it("prefers sourceName even when a signature is also present", () => {
    expect(
      stagedSortName(photo({ sourceName: "real.jpg", sourceSig: "other.jpg|1|2" })),
    ).toBe("real.jpg");
  });
});
