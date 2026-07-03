import { describe, expect, it } from "vitest";
import {
  autoGroupPhotos,
  compareByProvenance,
  type GroupablePhoto,
  hammingHex,
  MAX_AUTO_GROUP_PHOTOS,
  parseFilenameSequence,
  sequenceRuns,
  VISUAL_MERGE_MAX_DISTANCE,
  visualPairs,
} from "./autolister-grouping";

function p(
  id: string,
  iso: string | null,
  phash = "0000000000000000",
  sourceName?: string | null,
): GroupablePhoto {
  return { id, capturedAt: iso ? new Date(iso) : null, phash, sourceName };
}

describe("hammingHex", () => {
  it("is 0 for identical hashes", () => {
    expect(hammingHex("0000000000000000", "0000000000000000")).toBe(0);
  });
  it("counts single-bit differences", () => {
    expect(hammingHex("0000000000000000", "0000000000000001")).toBe(1);
    expect(hammingHex("0000000000000000", "0000000000000003")).toBe(2);
  });
  it("is max (64) for a missing/malformed hash", () => {
    expect(hammingHex("", "0000000000000000")).toBe(64);
    expect(hammingHex("zzzz", "0000000000000000")).toBe(64);
  });
});

describe("autoGroupPhotos", () => {
  it("splits capture-time bursts into separate item groups", () => {
    // Two bursts ~60s apart (> the 30s default gap), distinct phashes.
    const photos = [
      p("a1", "2024-01-01T10:00:00Z", "0000000000000000"),
      p("a2", "2024-01-01T10:00:05Z", "ffff000000000000"),
      p("b1", "2024-01-01T10:01:00Z", "0000ffff00000000"),
      p("b2", "2024-01-01T10:01:04Z", "00000000ffff0000"),
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(2);
    expect(new Set(groups[0]!.photoIds)).toEqual(new Set(["a1", "a2"]));
    expect(new Set(groups[1]!.photoIds)).toEqual(new Set(["b1", "b2"]));
    // Cover = earliest photo in the group.
    expect(groups[0]!.coverId).toBe("a1");
  });

  it("visual pass merges the same garment shot out of order", () => {
    // Two photos far apart in time but visually identical -> one group.
    const photos = [
      p("x", "2024-01-01T10:00:00Z", "1234567890abcdef"),
      p("y", "2024-01-01T10:30:00Z", "1234567890abcdef"),
    ];
    expect(visualPairs(photos)).toEqual([{ a: "x", b: "y", distance: 0 }]);
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0]!.photoIds)).toEqual(new Set(["x", "y"]));
  });

  it("keeps visually distinct items in separate groups even when visual is on", () => {
    const photos = [
      p("x", "2024-01-01T10:00:00Z", "0000000000000000"),
      p("y", "2024-01-01T10:30:00Z", "ffffffffffffffff"), // distance 64
    ];
    expect(visualPairs(photos)).toEqual([]);
    expect(autoGroupPhotos(photos)).toHaveLength(2);
  });

  it("puts a photo with no capture time in its own group", () => {
    const photos = [
      p("a1", "2024-01-01T10:00:00Z", "0000000000000000"),
      p("u", null, "abcabcabcabcabca"),
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(2);
    expect(groups.some((g) => g.photoIds.length === 1 && g.photoIds[0] === "u")).toBe(true);
  });

  it("returns [] for no photos", () => {
    expect(autoGroupPhotos([])).toEqual([]);
  });

  it("VISUAL_MERGE_MAX_DISTANCE is a conservative threshold", () => {
    expect(VISUAL_MERGE_MAX_DISTANCE).toBeLessThanOrEqual(12);
  });
});

// US-1540: filename-sequence signal ------------------------------------------

describe("parseFilenameSequence", () => {
  it("parses common camera formats (case-insensitive)", () => {
    expect(parseFilenameSequence("IMG_0551.jpg")).toEqual({ prefix: "img_", seq: 551 });
    expect(parseFilenameSequence("img_0551.JPG")).toEqual({ prefix: "img_", seq: 551 });
    expect(parseFilenameSequence("DSC01234.jpg")).toEqual({ prefix: "dsc", seq: 1234 });
    expect(parseFilenameSequence("DSCN9001.png")).toEqual({ prefix: "dscn", seq: 9001 });
    expect(parseFilenameSequence("DSC_4402.webp")).toEqual({ prefix: "dsc_", seq: 4402 });
    expect(parseFilenameSequence("IMG-2044.jpeg")).toEqual({ prefix: "img-", seq: 2044 });
  });

  it("parses WhatsApp and Pixel names by their trailing number", () => {
    expect(parseFilenameSequence("IMG-20240101-WA0012.jpg")).toEqual({
      prefix: "img-20240101-wa",
      seq: 12,
    });
    expect(parseFilenameSequence("PXL_20230801_103015123.jpg")).toEqual({
      prefix: "pxl_20230801_",
      seq: 103015123,
    });
  });

  it("ignores copy suffixes so a duplicate keeps its real sequence", () => {
    expect(parseFilenameSequence("IMG_0551 (1).jpg")).toEqual({ prefix: "img_", seq: 551 });
    expect(parseFilenameSequence("IMG_0551 - Copy.jpg")).toEqual({ prefix: "img_", seq: 551 });
    expect(parseFilenameSequence("IMG_0551 copy 2.jpg")).toEqual({ prefix: "img_", seq: 551 });
  });

  it("returns null for unusable names", () => {
    expect(parseFilenameSequence(null)).toBeNull();
    expect(parseFilenameSequence(undefined)).toBeNull();
    expect(parseFilenameSequence("")).toBeNull();
    expect(parseFilenameSequence("garment-front.jpg")).toBeNull();
  });
});

describe("sequenceRuns", () => {
  const named = (id: string, name: string) => ({ id, sourceName: name });

  it("splits on sequence gaps and prefix changes", () => {
    // Runs come back in (prefix, seq) order — "dsc_" sorts before "img_".
    const runs = sequenceRuns([
      named("a", "IMG_0001.jpg"),
      named("b", "IMG_0002.jpg"),
      named("c", "IMG_0004.jpg"), // gap (0003 missing) → new run
      named("d", "DSC_0005.jpg"), // prefix change → new run
    ]);
    expect(runs.map((r) => r.map((p) => p.id))).toEqual([["d"], ["a", "b"], ["c"]]);
  });

  it("keeps duplicate filenames (same sequence) in one run, and omits unparseable names", () => {
    const runs = sequenceRuns([
      named("a", "IMG_0001.jpg"),
      named("a2", "IMG_0001 (1).jpg"), // copy of 0001 → same seq → same run
      named("b", "IMG_0002.jpg"),
      named("x", "front.jpg"), // unparseable → omitted entirely
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.map((p) => p.id)).toEqual(["a", "a2", "b"]);
  });

  it("orders by sequence regardless of input order", () => {
    const runs = sequenceRuns([
      named("c", "IMG_0003.jpg"),
      named("a", "IMG_0001.jpg"),
      named("b", "IMG_0002.jpg"),
    ]);
    expect(runs.map((r) => r.map((p) => p.id))).toEqual([["a", "b", "c"]]);
  });
});

describe("autoGroupPhotos — filename-sequence grouping (US-1540)", () => {
  // Distinct phashes so the visual pass can't be what merges them.
  const HASHES = [
    "0000000000000000",
    "ffff000000000000",
    "0000ffff00000000",
    "00000000ffff0000",
    "000000000000ffff",
    "f0f0f0f0f0f0f0f0",
  ];

  it("groups a pure no-EXIF IMG_ run into one item instead of singletons", () => {
    const photos = [
      p("a", null, HASHES[0], "IMG_0551.jpg"),
      p("b", null, HASHES[1], "IMG_0552.jpg"),
      p("c", null, HASHES[2], "IMG_0553.jpg"),
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.photoIds).toEqual(["a", "b", "c"]);
    expect(groups[0]!.coverId).toBe("a");
  });

  it("two cameras (mixed prefixes) become two groups", () => {
    const photos = [
      p("a", null, HASHES[0], "IMG_0001.jpg"),
      p("b", null, HASHES[1], "IMG_0002.jpg"),
      p("x", null, HASHES[2], "DSC_0100.jpg"),
      p("y", null, HASHES[3], "DSC_0101.jpg"),
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.photoIds)).toEqual(
      expect.arrayContaining([["x", "y"], ["a", "b"]]),
    );
  });

  it("a missing number in a run starts a new candidate group", () => {
    const photos = [
      p("a", null, HASHES[0], "IMG_0001.jpg"),
      p("b", null, HASHES[1], "IMG_0002.jpg"),
      p("c", null, HASHES[2], "IMG_0007.jpg"), // gap
      p("d", null, HASHES[3], "IMG_0008.jpg"),
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.photoIds).toEqual(["a", "b"]);
    expect(groups[1]!.photoIds).toEqual(["c", "d"]);
  });

  it("no-EXIF WhatsApp-style names group by their WA sequence", () => {
    const photos = [
      p("a", null, HASHES[0], "IMG-20240101-WA0010.jpg"),
      p("b", null, HASHES[1], "IMG-20240101-WA0011.jpg"),
      p("c", null, HASHES[2], "IMG-20240101-WA0012.jpg"),
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.photoIds).toEqual(["a", "b", "c"]);
  });

  it("the dHash visual pass can still merge two sequence-adjacent runs of the same garment", () => {
    // Same phash across the gap → visual pass merges the two seeded runs.
    const photos = [
      p("a", null, "1234567890abcdef", "IMG_0001.jpg"),
      p("b", null, "1234567890abcdef", "IMG_0002.jpg"),
      p("c", null, "1234567890abcdef", "IMG_0009.jpg"), // gap → separate run…
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(1); // …but visually identical → merged
    expect(new Set(groups[0]!.photoIds)).toEqual(new Set(["a", "b", "c"]));
  });

  it("timeless photos with unusable names keep today's singleton behavior", () => {
    const photos = [
      p("u1", null, HASHES[0], "front.jpg"),
      p("u2", null, HASHES[1]), // no name at all
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.photoIds.length === 1)).toBe(true);
  });

  it("mixed sets: EXIF photos keep time-gap behavior while timeless ones group by sequence", () => {
    const photos = [
      // Timed burst — must group by TIME exactly as before, even though the
      // filenames are wildly out of sequence.
      p("t1", "2024-01-01T10:00:00Z", HASHES[0], "IMG_0900.jpg"),
      p("t2", "2024-01-01T10:00:05Z", HASHES[1], "IMG_0100.jpg"),
      // Timeless sequential pair.
      p("n1", null, HASHES[2], "IMG_0551.jpg"),
      p("n2", null, HASHES[3], "IMG_0552.jpg"),
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(2);
    // Timed group first (real capture time beats Infinity), ordered by time.
    expect(groups[0]!.photoIds).toEqual(["t1", "t2"]);
    expect(groups[1]!.photoIds).toEqual(["n1", "n2"]);
  });

  it("REGRESSION: EXIF time-gap + dHash behavior is unchanged when no names exist", () => {
    // The exact fixture of the original burst-split test, no sourceName.
    const photos = [
      p("a1", "2024-01-01T10:00:00Z", "0000000000000000"),
      p("a2", "2024-01-01T10:00:05Z", "ffff000000000000"),
      p("b1", "2024-01-01T10:01:00Z", "0000ffff00000000"),
      p("b2", "2024-01-01T10:01:04Z", "00000000ffff0000"),
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(2);
    expect(new Set(groups[0]!.photoIds)).toEqual(new Set(["a1", "a2"]));
    expect(new Set(groups[1]!.photoIds)).toEqual(new Set(["b1", "b2"]));
  });
});

// US-1541: 600-photo scale — grouping stays correct (and, with the integer
// popcount fast path, completes without a main-thread freeze; the old per-bit
// BigInt hamming took seconds over the ~180k pairs this produces).
describe("autoGroupPhotos — 600-photo session (US-1541)", () => {
  // Per-item hash with GUARANTEED pairwise distance: 5 index bits, each
  // expanded to a 12-bit ("fff"/"000") segment + a trailing pad nibble. Two
  // distinct items differ in ≥ 1 index bit ⇒ hamming ≥ 12 > the merge
  // threshold (10), so the visual pass can never falsely merge items, while
  // same-item shots share the hash exactly (distance 0 → always merged).
  function itemHash(item: number): string {
    let hash = "";
    for (let bit = 0; bit < 5; bit++) {
      hash += (item >> bit) & 1 ? "fff" : "000";
    }
    return `${hash}0`;
  }

  it("groups 600 photos (30 items × 20 shots) correctly through the O(n²) visual pass", () => {
    const photos: GroupablePhoto[] = [];
    const base = Date.parse("2024-01-01T09:00:00Z");
    for (let item = 0; item < 30; item++) {
      for (let shot = 0; shot < 20; shot++) {
        photos.push({
          id: `i${item}-s${shot}`,
          // 5s between shots (< the 30s gap), 10min between items (≫ gap).
          capturedAt: new Date(base + item * 600_000 + shot * 5_000),
          phash: itemHash(item),
          sourceName: `IMG_${String(item * 20 + shot).padStart(4, "0")}.jpg`,
        });
      }
    }
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(30);
    expect(groups.every((g) => g.photoIds.length === 20)).toBe(true);
    // Spot-check integrity: first group is item 0's shots in shot order.
    expect(groups[0]!.photoIds.slice(0, 3)).toEqual(["i0-s0", "i0-s1", "i0-s2"]);
    // The guaranteed-distance code really is > the merge threshold.
    expect(hammingHex(itemHash(0), itemHash(1))).toBeGreaterThan(
      VISUAL_MERGE_MAX_DISTANCE,
    );
  });

  it("hammingHex fast path matches known distances and rejects malformed hashes", () => {
    // Cross-check a few distances against hand-computed XOR popcounts.
    expect(hammingHex("ffffffffffffffff", "0000000000000000")).toBe(64);
    expect(hammingHex("00000000000000ff", "0000000000000000")).toBe(8);
    expect(hammingHex("8000000000000001", "0000000000000000")).toBe(2);
    // Malformed-but-16-chars must be rejected, not partially parsed.
    expect(hammingHex("0000zzzz0000zzzz", "0000000000000000")).toBe(64);
  });
});

// US-1550: bounded detection — the failure mode this guards against is a real
// 600-photo dump (EXIF stripped in export, contiguous filenames, same shooting
// background) collapsing into ONE group: the filename run seeded one giant
// cluster, and the unbounded dHash union chained the rest together.
describe("autoGroupPhotos — bounded detection (US-1550)", () => {
  it("a long contiguous no-EXIF filename run must NOT become one giant group", () => {
    // 40 timeless photos, contiguous names, all visually distinct.
    const photos = Array.from({ length: 40 }, (_, i) =>
      p(
        `p${i}`,
        null,
        // Distinct hashes pairwise ≥ 16 apart (4 index bits × 16-bit fields).
        `${[0, 1, 2, 3].map((bit) => ((i >> bit) & 1 ? "ffff" : "0000")).join("")}`,
        `IMG_${String(i + 1).padStart(4, "0")}.jpg`,
      ),
    );
    const groups = autoGroupPhotos(photos);
    const biggest = Math.max(...groups.map((g) => g.photoIds.length));
    expect(biggest).toBeLessThanOrEqual(MAX_AUTO_GROUP_PHOTOS);
    // Nothing dropped.
    expect(groups.flatMap((g) => g.photoIds)).toHaveLength(40);
  });

  it("visual merging is size-capped: identical hashes can't chain past the cap", () => {
    // 30 timeless, contiguous names, ALL the same hash (worst case: every
    // pair "similar"). Pre-US-1550 this became one 30-photo group.
    const photos = Array.from({ length: 30 }, (_, i) =>
      p(`p${i}`, null, "1234567890abcdef", `IMG_${String(i + 1).padStart(4, "0")}.jpg`),
    );
    const groups = autoGroupPhotos(photos);
    expect(Math.max(...groups.map((g) => g.photoIds.length))).toBeLessThanOrEqual(
      MAX_AUTO_GROUP_PHOTOS,
    );
    expect(groups.flatMap((g) => g.photoIds)).toHaveLength(30);
  });

  it("visual merging is local: similar photos far apart in shooting order stay apart", () => {
    // Ten timed singleton bursts (10 min apart); only the first and last are
    // visually identical. They're 9 clusters apart — a same-background false
    // positive, not a reshoot — so they must NOT merge.
    const base = Date.parse("2024-01-01T09:00:00Z");
    const photos = Array.from({ length: 10 }, (_, i) =>
      p(
        `p${i}`,
        new Date(base + i * 600_000).toISOString(),
        i === 0 || i === 9
          ? "1234567890abcdef"
          : `${[0, 1, 2, 3].map((bit) => ((i >> bit) & 1 ? "ffff" : "0000")).join("")}`,
      ),
    );
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(10);
  });

  it("a nearby same-garment reshoot still merges (the window allows neighbors)", () => {
    // Two timed bursts 10 min apart, visually identical → still one item.
    const photos = [
      p("x1", "2024-01-01T10:00:00Z", "1234567890abcdef"),
      p("x2", "2024-01-01T10:00:05Z", "1234567890abcdef"),
      p("y1", "2024-01-01T10:10:00Z", "1234567890abcdef"),
    ];
    const groups = autoGroupPhotos(photos);
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0]!.photoIds)).toEqual(new Set(["x1", "x2", "y1"]));
  });
});

describe("compareByProvenance (US-1540 grid ordering)", () => {
  it("orders by capture time first, unknown times last", () => {
    const early = { capturedAt: new Date("2024-01-01T10:00:00Z"), sourceName: "IMG_9999.jpg" };
    const late = { capturedAt: new Date("2024-01-01T11:00:00Z"), sourceName: "IMG_0001.jpg" };
    const timeless = { capturedAt: null, sourceName: "IMG_0000.jpg" };
    expect(compareByProvenance(early, late)).toBeLessThan(0);
    expect(compareByProvenance(late, timeless)).toBeLessThan(0);
  });

  it("breaks time ties by filename sequence; equal keys return 0 (stable-sort upload order)", () => {
    const t = new Date("2024-01-01T10:00:00Z");
    const a = { capturedAt: t, sourceName: "IMG_0001.jpg" };
    const b = { capturedAt: t, sourceName: "IMG_0002.jpg" };
    const unnamedX = { capturedAt: null, sourceName: null };
    const unnamedY = { capturedAt: null, sourceName: "no-digits.jpg" };
    expect(compareByProvenance(a, b)).toBeLessThan(0);
    expect(compareByProvenance(b, a)).toBeGreaterThan(0);
    // Parseable sequence sorts before unparseable at equal time.
    expect(compareByProvenance(a, { capturedAt: t, sourceName: null })).toBeLessThan(0);
    // Two unparseables tie → 0 (the caller's stable sort keeps upload order).
    expect(compareByProvenance(unnamedX, unnamedY)).toBe(0);
  });
});
