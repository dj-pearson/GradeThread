import { describe, expect, it } from "vitest";
import type { CapturePhoto } from "@/lib/phone-capture-client";
import {
  type StageableGroup,
  stageCapturedPhotos,
} from "../phone-capture-staging";

// US-3185: a bin shot on a phone becomes staged photos and one group per item.
//
// The failure this guards against is not a crash. It is the feature looking as
// though it works while every poll starts a fresh group for the same garment,
// or while twenty items arrive as one heap — both of which leave a grid the
// seller has to re-group by hand, which is the thing the Next item control
// exists to remove.

function photo(id: string, groupIndex: number): CapturePhoto {
  return {
    id,
    url: `https://example.test/${id}.jpg`,
    storagePath: `u/${id}.jpg`,
    width: 1200,
    height: 1600,
    bytes: 1000,
    groupIndex,
  };
}

/** Deterministic ids, so the assertions name what they mean. */
function ids(): () => string {
  let n = 0;
  return () => `n${++n}`;
}

describe("staging a phone-shot bin (US-3185)", () => {
  it("one item on the phone is one group in the grid", () => {
    const map = new Map<number, string>();
    const out = stageCapturedPhotos<StageableGroup>(
      [photo("a", 0), photo("b", 0), photo("c", 1)],
      [],
      map,
      ids(),
    );
    expect(out.groups).toHaveLength(2);
    expect(out.groups[0]?.photoIds).toHaveLength(2);
    expect(out.groups[1]?.photoIds).toHaveLength(1);
    expect(out.staged).toHaveLength(3);
    // Named from one, following on from whatever the seller already had.
    expect(out.groups.map((g) => g.name)).toEqual(["Item 1", "Item 2"]);
  });

  it("a second poll for the same item extends it rather than starting another", () => {
    // THE bug this file exists for. The dialog polls every three seconds, so
    // a garment photographed over two polls arrives twice; a fresh group each
    // time would turn one shirt into four items.
    const map = new Map<number, string>();
    // ONE generator across both polls. A fresh one per call would hand the
    // second poll the same ids as the first, so a group started twice would
    // collide back into one and this case would pass while the bug was live.
    // Measured: with a per-call generator, dropping the map lookup entirely
    // left all six cases green.
    const nextId = ids();
    const first = stageCapturedPhotos<StageableGroup>([photo("a", 0)], [], map, nextId);
    const second = stageCapturedPhotos<StageableGroup>(
      [photo("b", 0)],
      first.groups,
      map,
      nextId,
    );
    expect(second.groups).toHaveLength(1);
    expect(second.groups[0]?.photoIds).toHaveLength(2);
    expect(second.groups[0]?.id).toBe(first.groups[0]?.id);
  });

  it("groups the seller already had are kept and numbered past", () => {
    const existing: StageableGroup[] = [
      { id: "g-old", name: "Item 1", photoIds: ["p1"], coverId: "p1" },
    ];
    const out = stageCapturedPhotos<StageableGroup>(
      [photo("a", 0)],
      existing,
      new Map(),
      ids(),
    );
    expect(out.groups).toHaveLength(2);
    expect(out.groups[0]).toBe(existing[0]);
    expect(out.groups[1]?.name).toBe("Item 2");
  });

  it("the first shot of an item is its cover, because that is the order it was shot in", () => {
    const out = stageCapturedPhotos<StageableGroup>(
      [photo("a", 0), photo("b", 0)],
      [],
      new Map(),
      ids(),
    );
    expect(out.groups[0]?.coverId).toBe(out.groups[0]?.photoIds[0]);
  });

  it("a phone shot carries no capture time, and does not pretend to", () => {
    // The upload route strips EXIF (US-276), so there is nothing to read. A
    // fabricated timestamp would feed auto-grouping a signal it should not
    // have — the seller has already said where the boundaries are.
    const out = stageCapturedPhotos<StageableGroup>([photo("a", 0)], [], new Map(), ids());
    expect(out.staged[0]?.capturedAtMs).toBeNull();
    expect(out.staged[0]?.phash).toBe("");
    expect(out.staged[0]?.url).toBe("https://example.test/a.jpg");
    expect(out.staged[0]?.storagePath).toBe("u/a.jpg");
  });

  it("nothing arriving means nothing changes", () => {
    const existing: StageableGroup[] = [
      { id: "g", name: "Item 1", photoIds: ["p"], coverId: "p" },
    ];
    const out = stageCapturedPhotos<StageableGroup>([], existing, new Map(), ids());
    expect(out.staged).toEqual([]);
    expect(out.groups).toEqual(existing);
  });
});
