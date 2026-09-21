// US-3187: the join that decides a seller's photo is gone.
//
//   deno test --allow-read --allow-env src/tests/missing-photo-objects_test.ts
//
// The classifier is pure and the risky half is what it REFUSES, so most of
// these cases are about the answers it declines to give.
import { assert, assertEquals } from "@std/assert";
import {
  classifyMissingPhotoObjects,
  normalizePhotoPath,
  type PhotoRow,
} from "../lib/missing-photo-objects.ts";

const row = (over: Partial<PhotoRow> & { id: string }): PhotoRow => ({
  inventoryItemId: "item-1",
  ownerUserId: "owner-1",
  storagePath: `owner-1/item-1/${over.id}.jpg`,
  thumbnailStoragePath: null,
  createdAt: "2026-09-01T00:00:00Z",
  ...over,
});

Deno.test("US-3187: an unfinished listing classifies nothing", () => {
  // The whole point. A 403, a timeout and a truncated page all look like
  // "not there", and a report built on one would name live photos as dead.
  const report = classifyMissingPhotoObjects({
    rows: [row({ id: "a" })],
    presentPaths: new Set(),
    listingComplete: false,
  });
  assertEquals(report.dead, null);
  assert(report.refusal !== null);
  assert(report.refusal!.includes("did not finish"));
});

Deno.test("US-3187: a complete listing with everything present finds nothing", () => {
  // The control. Every negative assertion below would pass on a classifier
  // that returned an empty list no matter what it was handed.
  const report = classifyMissingPhotoObjects({
    rows: [row({ id: "a" }), row({ id: "b" })],
    presentPaths: new Set(["owner-1/item-1/a.jpg", "owner-1/item-1/b.jpg"]),
    listingComplete: true,
  });
  assertEquals(report.dead, []);
  assertEquals(report.refusal, null);
  assertEquals(report.rowsChecked, 2);
});

Deno.test("US-3187: one dead row beside live siblings reads as an upload that failed", () => {
  const report = classifyMissingPhotoObjects({
    rows: [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })],
    presentPaths: new Set(["owner-1/item-1/b.jpg", "owner-1/item-1/c.jpg"]),
    listingComplete: true,
  });
  assertEquals(report.dead!.length, 1);
  assertEquals(report.dead![0].row.id, "a");
  assertEquals(report.dead![0].kind, "both_gone");
  assertEquals(report.dead![0].shape, "isolated");
  assert(report.dead![0].causeHint.includes("failed the object"));
});

Deno.test("US-3187: every photo on one item dead reads as a folder delete", () => {
  const report = classifyMissingPhotoObjects({
    rows: [row({ id: "a" }), row({ id: "b" })],
    presentPaths: new Set(),
    listingComplete: true,
  });
  assertEquals(report.countsByShape.whole_item, 2);
  assertEquals(report.countsByShape.isolated, 0);
});

Deno.test("US-3187: dead rows across one owner's items read as a scoped cleanup", () => {
  const report = classifyMissingPhotoObjects({
    rows: [
      row({ id: "a", inventoryItemId: "item-1" }),
      row({ id: "b", inventoryItemId: "item-2", storagePath: "owner-1/item-2/b.jpg" }),
    ],
    presentPaths: new Set(),
    listingComplete: true,
  });
  assertEquals(report.countsByShape.whole_owner, 2);
  assertEquals(report.owners, ["owner-1"]);
});

Deno.test("US-3187: dead rows older than every live row, across owners, read as a restore", () => {
  const report = classifyMissingPhotoObjects({
    rows: [
      row({ id: "a", ownerUserId: "owner-1", createdAt: "2026-01-01T00:00:00Z" }),
      {
        ...row({ id: "b" }),
        ownerUserId: "owner-2",
        inventoryItemId: "item-2",
        storagePath: "owner-2/item-2/b.jpg",
        createdAt: "2026-01-02T00:00:00Z",
      },
      {
        ...row({ id: "live" }),
        ownerUserId: "owner-3",
        inventoryItemId: "item-3",
        storagePath: "owner-3/item-3/live.jpg",
        createdAt: "2026-06-01T00:00:00Z",
      },
    ],
    presentPaths: new Set(["owner-3/item-3/live.jpg"]),
    listingComplete: true,
  });
  assertEquals(report.countsByShape.older_than_every_live_row, 2);
  assertEquals(report.owners, ["owner-1", "owner-2"]);
  assertEquals(report.span, {
    oldest: "2026-01-01T00:00:00Z",
    newest: "2026-01-02T00:00:00Z",
  });
});

Deno.test("US-3187: a dead thumbnail beside a live photo is its own class", () => {
  // AC5. Lumping this in with both_gone would throw away a photo to fix a
  // thumbnail: the row is recoverable by clearing ONE column.
  const report = classifyMissingPhotoObjects({
    rows: [
      {
        ...row({ id: "a" }),
        thumbnailStoragePath: "owner-1/item-1/a_thumb.jpg",
      },
    ],
    presentPaths: new Set(["owner-1/item-1/a.jpg"]),
    listingComplete: true,
  });
  assertEquals(report.countsByKind.thumb_gone_photo_alive, 1);
  assertEquals(report.countsByKind.both_gone, 0);
});

Deno.test("US-3187: a dead photo beside a live thumbnail is the other class", () => {
  const report = classifyMissingPhotoObjects({
    rows: [
      {
        ...row({ id: "a" }),
        thumbnailStoragePath: "owner-1/item-1/a_thumb.jpg",
      },
    ],
    presentPaths: new Set(["owner-1/item-1/a_thumb.jpg"]),
    listingComplete: true,
  });
  assertEquals(report.countsByKind.photo_gone_thumb_alive, 1);
  assertEquals(report.countsByKind.both_gone, 0);
});

Deno.test("US-3187: a row that never had a thumbnail path is not a dead thumbnail", () => {
  // The obvious way to get this wrong: `thumbnail_storage_path` is nullable and
  // most rows have none, so treating null as missing would report the entire
  // table.
  const report = classifyMissingPhotoObjects({
    rows: [row({ id: "a", thumbnailStoragePath: null })],
    presentPaths: new Set(["owner-1/item-1/a.jpg"]),
    listingComplete: true,
  });
  assertEquals(report.dead, []);
});

Deno.test("US-3187: a row with no path at all is counted, never classified dead", () => {
  const report = classifyMissingPhotoObjects({
    rows: [row({ id: "a", storagePath: null, thumbnailStoragePath: null })],
    presentPaths: new Set(),
    listingComplete: true,
  });
  assertEquals(report.dead, []);
  assertEquals(report.withoutPath, 1);
  assertEquals(report.countsByKind.no_path_recorded, 1);
});

Deno.test("US-3187: a bucket prefix or a leading slash is the same object", () => {
  // The failure this prevents is the expensive direction: a stored path that
  // does not match the listing byte-for-byte reads as a dead photo.
  assertEquals(normalizePhotoPath("/item-photos/o/i/a.jpg", "item-photos"), "o/i/a.jpg");
  assertEquals(normalizePhotoPath("o/i/a%20b.jpg"), "o/i/a b.jpg");
  const report = classifyMissingPhotoObjects({
    rows: [row({ id: "a", storagePath: "/item-photos/owner-1/item-1/a.jpg" })],
    presentPaths: new Set(["owner-1/item-1/a.jpg"]),
    listingComplete: true,
    bucket: "item-photos",
  });
  assertEquals(report.dead, []);
});

Deno.test("US-3187: the confirmed production path shape classifies", () => {
  // From AC1, the row found on 2026-09-08. Kept literal so a change to the
  // path format shows up here rather than in a silent miss.
  const path = "c55c2414-7e0b-4431-944e-c0a16887bf31/" +
    "a478a7b2-bd0d-43db-b9ed-37f59eaa17c1/front_1781056170564.jpg";
  const report = classifyMissingPhotoObjects({
    rows: [
      row({
        id: "confirmed",
        ownerUserId: "c55c2414-7e0b-4431-944e-c0a16887bf31",
        inventoryItemId: "a478a7b2-bd0d-43db-b9ed-37f59eaa17c1",
        storagePath: path,
      }),
    ],
    presentPaths: new Set(),
    listingComplete: true,
  });
  assertEquals(report.dead!.length, 1);
  assertEquals(report.dead![0].kind, "both_gone");
});

Deno.test("US-3187: a dead photo on a row that never had a thumbnail is both_gone", () => {
  // The case that caught a real defect while this file was being written.
  // Most rows carry no thumbnail_storage_path, so reading its absence as a
  // surviving thumbnail filed the COMMONEST case under the class AC5 describes
  // as recoverable by clearing one column. There is no column to clear, and an
  // operator acting on that report would have cleared a path and believed the
  // photo was back.
  const report = classifyMissingPhotoObjects({
    rows: [row({ id: "a", thumbnailStoragePath: null })],
    presentPaths: new Set(),
    listingComplete: true,
  });
  assertEquals(report.countsByKind.both_gone, 1);
  assertEquals(report.countsByKind.photo_gone_thumb_alive, 0);
});
