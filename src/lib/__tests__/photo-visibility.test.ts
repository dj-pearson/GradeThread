import { describe, expect, it } from "vitest";
import {
  decodeTagMemo,
  encodeTagMemo,
  hideTag,
  isHiddenFromListing,
  isTagMemo,
  RESTORE_FALLBACK_TYPE,
  showTag,
} from "@/lib/photo-visibility";
import { isNonListablePhotoType } from "@/lib/constants";

describe("US-2669: the composer's hide-from-listing toggle", () => {
  it("hides by writing the tag every marketplace filter already drops", () => {
    const next = hideTag("front", null);
    expect(next.type).toBe("internal");
    expect(isNonListablePhotoType(next.type, next.role)).toBe(true);
  });

  it("round-trips a plain tag", () => {
    const hidden = hideTag("front", null);
    expect(showTag(hidden.role)).toEqual({ type: "front", role: null });
  });

  it("round-trips a tag that carries a role", () => {
    const hidden = hideTag("detail", "fabric");
    expect(hidden.type).toBe("internal");
    expect(showTag(hidden.role)).toEqual({ type: "detail", role: "fabric" });
  });

  it("round-trips a role containing a slash", () => {
    // No role in the vocabulary has one today, but photo_role is open text and
    // a memo that splits on the LAST slash would silently corrupt one.
    const hidden = hideTag("detail", "wear/tear");
    expect(showTag(hidden.role)).toEqual({ type: "detail", role: "wear/tear" });
  });

  it("keeps the memo when an already-hidden photo is hidden again", () => {
    const once = hideTag("detail", "fabric");
    const twice = hideTag(once.type, once.role);
    expect(twice.role).toBe(once.role);
    expect(showTag(twice.role)).toEqual({ type: "detail", role: "fabric" });
  });

  it("falls back to a neutral listable tag when nothing was remembered", () => {
    // A photo tagged "Internal (not listed)" by hand, or before the eye existed.
    expect(showTag(null)).toEqual({ type: RESTORE_FALLBACK_TYPE, role: null });
    expect(isNonListablePhotoType(RESTORE_FALLBACK_TYPE, null)).toBe(false);
  });

  it("refuses a memo naming a type this build does not know", () => {
    // Written by a newer client, read by an older one. Restoring it verbatim
    // would send the enum a value it rejects and fail the un-hide.
    expect(decodeTagMemo("was:hologram")).toBeNull();
    expect(showTag("was:hologram")).toEqual({
      type: RESTORE_FALLBACK_TYPE,
      role: null,
    });
  });

  it("never restores INTO hidden", () => {
    expect(decodeTagMemo("was:internal")).toBeNull();
    expect(isHiddenFromListing(showTag("was:internal").type)).toBe(false);
  });

  it("treats a real qualifier as a qualifier, not a memo", () => {
    expect(isTagMemo("fabric")).toBe(false);
    expect(isTagMemo(null)).toBe(false);
    expect(isTagMemo(encodeTagMemo("front"))).toBe(true);
  });

  it("leaves the MeasureCard frame's own non-listable rule alone", () => {
    // The card frame is not 'internal', so the eye reports it as locked rather
    // than as something the seller hid and can un-hide.
    expect(isHiddenFromListing("measurement")).toBe(false);
    expect(isNonListablePhotoType("measurement", null)).toBe(true);
  });

  it("does not make a hidden photo listable via its memo role", () => {
    // The memo is a role, and a 'measurement' with a role IS listable — proof
    // that the non-listable rule keys on the type for 'internal'.
    const hidden = hideTag("measurement", "chest");
    expect(isNonListablePhotoType(hidden.type, hidden.role)).toBe(true);
  });
});
