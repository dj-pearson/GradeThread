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
  bumpItemPhotoUrl,
  itemPhotoPublishUrl,
  itemPhotoUrlToken,
  needsSignedDisplayUrl,
  resolveItemPhotoDisplayUrl,
  resolveItemPhotoOriginalUrl,
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
      storage_path: "user-a/item-1/front_1.jpg",
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

  // US-2407: the report was "change the tag to anything else and the image
  // disappears". Retagging writes photo_type and nothing else — the bytes never
  // move — but the resolver keyed the private branch on the TYPE, so a tag
  // relabelled "Front" fell through to the public branch, where photo_url is ""
  // for a private upload. The tile went blank on a row that was entirely intact.
  it("keeps signing after the seller retags a private photo to a listing type", async () => {
    const sign = fakeSigner();
    for (const photo_type of ["front", "back", "detail", "flatlay"]) {
      _clearItemPhotoUrlCache();
      const url = await resolveItemPhotoDisplayUrl(
        { ...iosTag, photo_type },
        { sign },
      );
      expect(url, `retagged to ${photo_type}`).toContain("/object/sign/");
    }
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

  // US-2407: a private edit overwrites the bytes at an unchanged path, so
  // without an explicit bust the cached URL keeps resolving and the browser
  // keeps serving the pre-edit image from its own cache — the seller's crop
  // saves correctly and appears not to have happened.
  it("bumpItemPhotoUrl forces a re-sign and moves the display key", async () => {
    const sign = fakeSigner();
    const now = () => 1_000_000;
    await resolveItemPhotoDisplayUrl(iosTag, { sign, now });
    expect(sign).toHaveBeenCalledTimes(1);
    const before = itemPhotoUrlToken(iosTag.storage_path);

    bumpItemPhotoUrl(iosTag.storage_path);
    await resolveItemPhotoDisplayUrl(iosTag, { sign, now });

    expect(sign).toHaveBeenCalledTimes(2);
    expect(itemPhotoUrlToken(iosTag.storage_path)).toBe(before + 1);
    // Untouched objects keep their cache.
    expect(itemPhotoUrlToken("user-a/sub-1/other.jpg")).toBe(0);
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

  it("needsSignedDisplayUrl matches the private-upload SHAPE, not the type", () => {
    expect(needsSignedDisplayUrl(iosTag)).toBe(true);
    // A stored public URL means the bytes are public, whatever the type says.
    expect(needsSignedDisplayUrl({ ...iosTag, photo_url: "https://x" })).toBe(false);
    expect(
      needsSignedDisplayUrl({
        photo_type: "front",
        photo_url: "https://x",
        storage_path: "p",
      }),
    ).toBe(false);
    // Nothing to sign.
    expect(needsSignedDisplayUrl({ photo_type: "tag", storage_path: null })).toBe(false);
    // US-2407: the retagged private photo. Type says "front", bytes say private.
    expect(needsSignedDisplayUrl({ ...iosTag, photo_type: "front" })).toBe(true);
  });
});

// The PHOTO EDITOR opened on `photo.photo_url` and built the pre-edit original's
// URL against the public item-photos bucket. Both are wrong for an iOS Garment
// Tag: it lives in the PRIVATE bucket with an empty photo_url, so the editor
// rendered a broken image and "Revert to original" pointed at a 400. This is the
// desktop half of the "tag uploaded but corrupt" report — the bytes were always
// fine, only the read path was.
describe("resolveItemPhotoOriginalUrl (private-bucket originals)", () => {
  const iosTagWithOriginal: PhotoLike = {
    ...iosTag,
    original_storage_path: "user-a/sub-1/tag_123_original.jpg",
  };

  it("signs the original for a private-bucket tag", async () => {
    const sign = fakeSigner();
    const url = await resolveItemPhotoOriginalUrl(iosTagWithOriginal, { sign });
    expect(url).toContain("/object/sign/");
    expect(url).toContain("tag_123_original.jpg");
    // Signed against the ORIGINAL's path, not the current object's.
    expect(sign).toHaveBeenCalledWith("user-a/sub-1/tag_123_original.jpg");
  });

  it("uses the public URL for a normal front photo, never a signed one", async () => {
    const sign = fakeSigner();
    const url = await resolveItemPhotoOriginalUrl(
      {
        photo_type: "front",
        photo_url: "https://cdn.example.com/item-photos/front.jpg",
        storage_path: "user-a/sub-1/front.jpg",
        original_storage_path: "user-a/sub-1/front_original.jpg",
      },
      { sign, publicUrl: (p) => `https://cdn.example.com/item-photos/${p}` },
    );
    expect(url).toBe(
      "https://cdn.example.com/item-photos/user-a/sub-1/front_original.jpg",
    );
    expect(sign).not.toHaveBeenCalled();
  });

  it("returns empty when no original was preserved, without signing", async () => {
    const sign = fakeSigner();
    expect(await resolveItemPhotoOriginalUrl(iosTag, { sign })).toBe("");
    expect(sign).not.toHaveBeenCalled();
  });

  it("treats a web-uploaded tag (public photo_url) as public", async () => {
    const sign = fakeSigner();
    const url = await resolveItemPhotoOriginalUrl(
      {
        photo_type: "tag",
        photo_url: "https://cdn.example.com/item-photos/tag.jpg",
        storage_path: "user-a/sub-1/tag.jpg",
        original_storage_path: "user-a/sub-1/tag_original.jpg",
      },
      { sign, publicUrl: (p) => `https://cdn.example.com/item-photos/${p}` },
    );
    expect(url).toContain("tag_original.jpg");
    expect(sign).not.toHaveBeenCalled();
  });
});
