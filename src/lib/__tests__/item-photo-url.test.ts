// US-2273: the item-photo display resolver.
//
// AC5 pins the resolution table (signed for the private sensitive case, the
// stored public URL otherwise, no request for empty input). AC6 pins that a
// private-bucket photo is never handed to a public/persist destination: the
// display URL is a short-lived signed URL, and the publish path yields the plain
// public URL only — never the signed one.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearItemPhotoUrlCache,
  itemPhotoPublishUrl,
  needsSignedDisplayUrl,
  resolveItemPhotoDisplayUrl,
  type PhotoLike,
  type SignedUrlSigner,
} from "@/lib/item-photo-url";

function fakeSigner() {
  return vi.fn<SignedUrlSigner>((path) =>
    Promise.resolve(
      `https://sb.local/storage/v1/object/sign/submission-images/${path}?token=abc`,
    ),
  );
}

const iosTag: PhotoLike = {
  photo_type: "tag",
  photo_url: "", // iOS writes "" for private uploads
  thumbnail_url: null,
  storage_path: "user-a/sub-1/tag_123.jpg",
};

beforeEach(() => {
  _clearItemPhotoUrlCache();
});

describe("resolveItemPhotoDisplayUrl (AC5)", () => {
  it("signs the private bucket for a sensitive type with an empty photo_url", async () => {
    const sign = fakeSigner();
    const url = await resolveItemPhotoDisplayUrl(iosTag, { sign });
    expect(url).toContain("/object/sign/");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith("user-a/sub-1/tag_123.jpg");
  });

  it.each(["tag", "tag_2", "certificate"])(
    "signs for sensitive type %s",
    async (photo_type) => {
      const sign = fakeSigner();
      const url = await resolveItemPhotoDisplayUrl(
        { ...iosTag, photo_type },
        { sign },
      );
      expect(url).toContain("/object/sign/");
    },
  );

  it("leaves a web-uploaded tag's stored photo_url untouched (no signing)", async () => {
    const sign = fakeSigner();
    const webTag: PhotoLike = {
      photo_type: "tag",
      photo_url: "https://cdn.example.com/item-photos/tag.jpg",
      thumbnail_url: null,
      storage_path: "user-a/sub-1/tag_123.jpg",
    };
    const url = await resolveItemPhotoDisplayUrl(webTag, { sign });
    expect(url).toBe("https://cdn.example.com/item-photos/tag.jpg");
    expect(sign).not.toHaveBeenCalled();
  });

  it("returns the public URL for front/back with no signing", async () => {
    const sign = fakeSigner();
    const front: PhotoLike = {
      photo_type: "front",
      photo_url: "https://cdn.example.com/item-photos/front.jpg",
    };
    const url = await resolveItemPhotoDisplayUrl(front, { sign });
    expect(url).toBe("https://cdn.example.com/item-photos/front.jpg");
    expect(url).not.toContain("/object/sign/");
    expect(sign).not.toHaveBeenCalled();
  });

  it("makes no request for empty input", async () => {
    const sign = fakeSigner();
    const url = await resolveItemPhotoDisplayUrl({}, { sign });
    expect(url).toBe("");
    expect(sign).not.toHaveBeenCalled();
  });

  it("makes no request for a sensitive row with no storage_path to sign", async () => {
    const sign = fakeSigner();
    const url = await resolveItemPhotoDisplayUrl(
      { photo_type: "tag", photo_url: "", storage_path: null },
      { sign },
    );
    expect(url).toBe("");
    expect(sign).not.toHaveBeenCalled();
  });

  it("caches the signed URL per storage_path (no re-sign within the TTL window)", async () => {
    const sign = fakeSigner();
    const now = () => 1_000_000;
    const a = await resolveItemPhotoDisplayUrl(iosTag, { sign, now });
    const b = await resolveItemPhotoDisplayUrl(iosTag, { sign, now });
    expect(a).toBe(b);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("degrades to '' (labelled-placeholder signal) when the mint fails", async () => {
    const sign: SignedUrlSigner = () => Promise.resolve("");
    const url = await resolveItemPhotoDisplayUrl(iosTag, { sign });
    expect(url).toBe("");
  });

  it("full: returns the original photo_url (not the thumbnail) on the public path", async () => {
    const url = await resolveItemPhotoDisplayUrl(
      {
        photo_type: "front",
        photo_url: "https://cdn.example.com/item-photos/front-full.jpg",
        thumbnail_url: "https://cdn.example.com/item-photos/front-320.jpg",
      },
      { full: true },
    );
    expect(url).toBe("https://cdn.example.com/item-photos/front-full.jpg");
  });
});

describe("private photos never reach a public destination (AC6)", () => {
  it("itemPhotoPublishUrl never returns a signed URL for a sensitive photo", async () => {
    const sign = fakeSigner();
    // First mint a signed display URL — the value that must NOT be persisted.
    const display = await resolveItemPhotoDisplayUrl(iosTag, { sign });
    expect(display).toContain("/object/sign/");

    // The publish path yields the plain public photo_url ("" for iOS uploads),
    // never the ephemeral signed URL.
    const publish = itemPhotoPublishUrl(iosTag);
    expect(publish).toBe("");
    expect(publish).not.toContain("/object/sign/");
  });

  it("itemPhotoPublishUrl returns the public URL for a listable photo", () => {
    expect(
      itemPhotoPublishUrl({
        photo_type: "front",
        photo_url: "https://cdn.example.com/item-photos/front.jpg",
      }),
    ).toBe("https://cdn.example.com/item-photos/front.jpg");
  });

  it("needsSignedDisplayUrl only matches the iOS private-upload shape", () => {
    expect(needsSignedDisplayUrl(iosTag)).toBe(true);
    expect(needsSignedDisplayUrl({ ...iosTag, photo_url: "https://x" })).toBe(false);
    expect(needsSignedDisplayUrl({ photo_type: "front", storage_path: "p" })).toBe(false);
    expect(needsSignedDisplayUrl({ photo_type: "tag", storage_path: null })).toBe(false);
  });
});
