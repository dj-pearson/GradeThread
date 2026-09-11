import { describe, expect, it } from "vitest";
import {
  buildGroupName,
  DEFAULT_GROUP_NAME_RE,
  extractSizeFromOcr,
  isDefaultGroupName,
  nameFromSourceName,
  pickOcrPhoto,
  planOcrPass,
  tidyOcrText,
  uniqueGroupName,
} from "./autolister-tag-ocr";

describe("isDefaultGroupName", () => {
  it("matches the minted placeholder", () => {
    expect(isDefaultGroupName("Item 1")).toBe(true);
    expect(isDefaultGroupName("Item 42")).toBe(true);
    expect(isDefaultGroupName("  Item 7  ")).toBe(true);
  });

  it("treats an empty name as still-unnamed", () => {
    expect(isDefaultGroupName("")).toBe(true);
    expect(isDefaultGroupName("   ")).toBe(true);
    expect(isDefaultGroupName(undefined)).toBe(true);
  });

  it("leaves anything the seller typed alone", () => {
    expect(isDefaultGroupName("Item 1 - blue")).toBe(false);
    expect(isDefaultGroupName("Levi's 32x34")).toBe(false);
    expect(isDefaultGroupName("Items 3")).toBe(false);
    // A previous OCR result is a real name: re-running must not overwrite it.
    expect(isDefaultGroupName("Carhartt L")).toBe(false);
  });

  it("exports the regex it matches on, unanchored-safe", () => {
    expect(DEFAULT_GROUP_NAME_RE.test("Item 9")).toBe(true);
    expect(DEFAULT_GROUP_NAME_RE.test("xItem 9")).toBe(false);
  });
});

describe("pickOcrPhoto", () => {
  const photo = (id: string, role?: string) => ({ id, role });

  it("prefers a tag photo over everything else", () => {
    const picked = pickOcrPhoto([
      photo("a", "front"),
      photo("b", "tag"),
      photo("c", "detail"),
    ]);
    expect(picked?.id).toBe("b");
  });

  it("falls back to label-like roles when no tag is typed", () => {
    expect(pickOcrPhoto([photo("a", "front"), photo("b", "interior")])?.id).toBe("b");
    expect(pickOcrPhoto([photo("a", "detail"), photo("b", "marking")])?.id).toBe("b");
  });

  it("never reads a seller-reference or measurement shot", () => {
    // `internal` is the price tag the seller paid — US-1549 keeps it out of
    // every pass, and its text would name the group after a thrift store.
    expect(pickOcrPhoto([photo("a", "internal")])).toBeNull();
    expect(pickOcrPhoto([photo("a", "measurement")])).toBeNull();
  });

  it("returns null when the group has nothing label-like", () => {
    expect(pickOcrPhoto([photo("a", "front"), photo("b", "back")])).toBeNull();
    expect(pickOcrPhoto([])).toBeNull();
  });

  it("keeps input order among equally good candidates", () => {
    expect(pickOcrPhoto([photo("a", "tag"), photo("b", "tag")])?.id).toBe("a");
  });

  it("treats a missing role as the detail default, not a tag", () => {
    expect(pickOcrPhoto([photo("a")])).toBeNull();
  });
});

describe("tidyOcrText", () => {
  it("collapses the line noise tesseract emits", () => {
    expect(tidyOcrText("LEVI'S\n\n  ®  \n\n 32 x 34 ")).toBe("LEVI'S ® 32 x 34");
  });

  it("is empty for text that is only punctuation", () => {
    expect(tidyOcrText("~~ .. || ")).toBe("");
    expect(tidyOcrText("")).toBe("");
  });

  it("keeps letters, digits and the marks a size needs", () => {
    expect(tidyOcrText("SIZE: 10 1/2")).toBe("SIZE: 10 1/2");
  });
});

describe("extractSizeFromOcr", () => {
  it("reads a labelled size", () => {
    expect(extractSizeFromOcr("100% COTTON SIZE M MADE IN USA")).toBe("M");
    expect(extractSizeFromOcr("Size: Large")).toBe("L");
  });

  it("reads waist x inseam", () => {
    expect(extractSizeFromOcr("LEVI'S 505 32 X 34")).toBe("32x34");
    expect(extractSizeFromOcr("W34 L32")).toBe("34x32");
    expect(extractSizeFromOcr("34x30")).toBe("34x30");
  });

  it("reads a bare letter size when it stands alone", () => {
    expect(extractSizeFromOcr("CARHARTT\nXL\nMADE IN MEXICO")).toBe("XL");
    expect(extractSizeFromOcr("NIKE\nXXL")).toBe("2XL");
  });

  it("normalizes the long spellings and the X runs", () => {
    expect(extractSizeFromOcr("Size Medium")).toBe("M");
    expect(extractSizeFromOcr("SIZE XXXL")).toBe("3XL");
    expect(extractSizeFromOcr("size 2xl")).toBe("2XL");
  });

  it("reads a numeric size only when the label says so", () => {
    expect(extractSizeFromOcr("SIZE 10")).toBe("10");
    // A bare number on a care label is fibre percentage or an RN, not a size.
    expect(extractSizeFromOcr("100% COTTON RN 12345")).toBeNull();
  });

  it("does not mistake a fibre percentage for a size", () => {
    expect(extractSizeFromOcr("60% COTTON 40% POLYESTER")).toBeNull();
  });

  it("does not read L or M out of a care instruction", () => {
    expect(extractSizeFromOcr("MACHINE WASH COLD TUMBLE DRY LOW")).toBeNull();
  });

  it("returns null for text with no size at all", () => {
    expect(extractSizeFromOcr("")).toBeNull();
    expect(extractSizeFromOcr("MADE IN VIETNAM")).toBeNull();
  });
});

describe("nameFromSourceName", () => {
  it("uses a filename a person clearly typed", () => {
    expect(nameFromSourceName("carhartt detroit jacket.jpg")).toBe(
      "Carhartt Detroit Jacket",
    );
    expect(nameFromSourceName("blue-wool-coat.HEIC")).toBe("Blue Wool Coat");
  });

  it("rejects the camera's own naming", () => {
    expect(nameFromSourceName("IMG_2841.jpg")).toBeNull();
    expect(nameFromSourceName("PXL_20260907_143512345.jpg")).toBeNull();
    expect(nameFromSourceName("DSC00123.JPG")).toBeNull();
    expect(nameFromSourceName("20260907_143512.jpg")).toBeNull();
    expect(nameFromSourceName("photo-3.png")).toBeNull();
  });

  it("rejects a name with no letters, or one word too short to mean anything", () => {
    expect(nameFromSourceName("1234.jpg")).toBeNull();
    expect(nameFromSourceName("a.jpg")).toBeNull();
    expect(nameFromSourceName(undefined)).toBeNull();
  });

  it("caps a runaway filename", () => {
    const long = `${"windbreaker ".repeat(20)}.jpg`;
    expect(nameFromSourceName(long)!.length).toBeLessThanOrEqual(60);
  });
});

describe("buildGroupName", () => {
  it("is brand plus size when both are read", () => {
    expect(buildGroupName({ brand: "Levi's", size: "32x34" })).toBe("Levi's 32x34");
  });

  it("is brand alone when the size is unreadable", () => {
    expect(buildGroupName({ brand: "Carhartt" })).toBe("Carhartt");
  });

  it("falls back to the filename when no brand was found", () => {
    expect(buildGroupName({ size: "M", sourceName: "blue wool coat.jpg" })).toBe(
      "Blue Wool Coat M",
    );
  });

  // US-3349: the color-plus-garment rung that used to sit here is gone, and so
  // is its test. It could not be reached from the one caller, so its green was
  // about the function and not about anything a seller sees. A camera filename
  // with no brand now means the group keeps "Item N", which is what happens in
  // production today.
  it("returns null when it knows nothing worth saying", () => {
    expect(buildGroupName({})).toBeNull();
    expect(buildGroupName({ sourceName: "IMG_1.jpg" })).toBeNull();
    expect(buildGroupName({ size: "M", sourceName: "IMG_1.jpg" })).toBeNull();
  });

  it("does not repeat the brand when the filename already carries it", () => {
    expect(buildGroupName({ brand: "Carhartt", sourceName: "carhartt jacket.jpg" }))
      .toBe("Carhartt");
  });

  it("puts the size last so names sort by brand", () => {
    expect(buildGroupName({ brand: "Nike", size: "L" })).toBe("Nike L");
    expect(buildGroupName({ size: "L", sourceName: "blue tee.jpg" })).toBe(
      "Blue Tee L",
    );
  });
});

describe("uniqueGroupName", () => {
  it("returns the name unchanged when nothing else has it", () => {
    expect(uniqueGroupName("Levi's 32x34", new Set())).toBe("Levi's 32x34");
  });

  it("numbers a repeat rather than leaving two identical names", () => {
    const taken = new Set(["Carhartt"]);
    expect(uniqueGroupName("Carhartt", taken)).toBe("Carhartt 2");
  });

  it("keeps counting past the first collision", () => {
    const taken = new Set(["Carhartt", "Carhartt 2", "Carhartt 3"]);
    expect(uniqueGroupName("Carhartt", taken)).toBe("Carhartt 4");
  });

  it("compares case-insensitively — two spellings are still one name", () => {
    expect(uniqueGroupName("Carhartt", new Set(["carhartt"]))).toBe("Carhartt 2");
  });
});

describe("planOcrPass", () => {
  const g = (
    id: string,
    name: string,
    photoIds: string[],
    roles?: Record<string, string>,
  ) => ({ id, name, photoIds, roles });

  it("queues a minted group and points at its tag photo", () => {
    const jobs = planOcrPass(
      [g("g1", "Item 1", ["p1", "p2"], { p1: "front", p2: "tag" })],
      new Set(),
    );
    expect(jobs).toEqual([{ groupId: "g1", photoId: "p2", key: "g1:p2" }]);
  });

  it("skips a group the seller has named", () => {
    expect(
      planOcrPass([g("g1", "Levi's 32x34", ["p1"], { p1: "tag" })], new Set()),
    ).toEqual([]);
  });

  it("still queues a group with no tag photo, for the filename fallback", () => {
    const jobs = planOcrPass([g("g1", "Item 1", ["p1"], { p1: "front" })], new Set());
    expect(jobs).toEqual([{ groupId: "g1", photoId: null, key: "g1:none" }]);
  });

  it("does not retry a pair already attempted", () => {
    const groups = [g("g1", "Item 1", ["p1"], { p1: "tag" })];
    const attempted = new Set(planOcrPass(groups, new Set()).map((j) => j.key));
    expect(planOcrPass(groups, attempted)).toEqual([]);
  });

  it("retries when a DIFFERENT photo becomes the tag", () => {
    // The seller re-tagged: the pair key changes, so the group is eligible again
    // even though it was already attempted once.
    const attempted = new Set(["g1:p1"]);
    const jobs = planOcrPass(
      [g("g1", "Item 1", ["p1", "p2"], { p1: "front", p2: "tag" })],
      attempted,
    );
    expect(jobs.map((j) => j.photoId)).toEqual(["p2"]);
  });

  it("returns nothing for an empty session", () => {
    expect(planOcrPass([], new Set())).toEqual([]);
  });
});
