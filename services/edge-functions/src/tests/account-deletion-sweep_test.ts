import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { collectSubmissionImagePaths } from "../routes/account.ts";

// US-1637: account deletion must sweep the metadata-INTACT originals and dispute
// evidence from the submission-images bucket, not just the served storage_path —
// otherwise GPS-bearing PII survives a "completed" deletion.

Deno.test("collectSubmissionImagePaths includes served + original image paths", () => {
  const paths = collectSubmissionImagePaths(
    [
      { storage_path: "u/1/front.jpg", original_storage_path: "u/1/front.orig.jpg" },
      { storage_path: "u/1/back.jpg", original_storage_path: null },
    ],
    [],
  );
  assertEquals(paths.sort(), [
    "u/1/back.jpg",
    "u/1/front.jpg",
    "u/1/front.orig.jpg",
  ]);
});

Deno.test("collectSubmissionImagePaths includes dispute evidence paths", () => {
  const paths = collectSubmissionImagePaths(
    [{ storage_path: "u/1/front.jpg", original_storage_path: null }],
    [
      { evidence_paths: ["u/1/evidence-a.jpg", "u/1/evidence-b.jpg"] },
      { evidence_paths: null },
    ],
  );
  assertEquals(paths.sort(), [
    "u/1/evidence-a.jpg",
    "u/1/evidence-b.jpg",
    "u/1/front.jpg",
  ]);
});

Deno.test("collectSubmissionImagePaths drops empties and de-duplicates", () => {
  const paths = collectSubmissionImagePaths(
    [
      { storage_path: "u/1/dup.jpg", original_storage_path: "" },
      { storage_path: "u/1/dup.jpg", original_storage_path: null },
    ],
    [{ evidence_paths: ["u/1/dup.jpg", ""] }],
  );
  assertEquals(paths, ["u/1/dup.jpg"]);
});

Deno.test("collectSubmissionImagePaths returns [] for an account with no images", () => {
  assertEquals(collectSubmissionImagePaths([], []), []);
});

// ── US-2645: arrival captures are the fourth source in submission-images ──────
//
// purchase_arrival_captures (00418) writes a BUYER's photos of a garment as it
// arrived into the same private bucket, at {userId}/{purchaseId}/arrival_*. It
// landed after US-1637 swept the other three sources and was never added here,
// so account deletion cascaded the ROW away and left the PHOTOGRAPH behind.
//
// That is worse than merely retained. Every sweep in this codebase drives off DB
// rows, so once the row is gone the object is unreachable by any future job —
// {deleted:true} was returned over bytes nothing can ever find again.
//
// Third instance of one pattern: originals (US-1637), dispute evidence
// (US-1637), and now arrival captures. Each was a new writer into an existing
// bucket whose author had no reason to look at a deletion routine.

Deno.test("US-2645: arrival capture paths are collected for erasure", () => {
  const paths = collectSubmissionImagePaths(
    [{ storage_path: "u1/s1/front.jpg", original_storage_path: null }],
    [],
    [
      { storage_path: "u1/p9/arrival_front_1.jpg" },
      { storage_path: "u1/p9/arrival_label_2.jpg" },
    ],
  );
  assert(paths.includes("u1/p9/arrival_front_1.jpg"));
  assert(paths.includes("u1/p9/arrival_label_2.jpg"));
  assert(paths.includes("u1/s1/front.jpg"), "the existing sources must still be swept");
});

Deno.test("US-2645: a null or absent arrival path is skipped, not stringified", () => {
  // A null path removed as the literal "null" would 404 harmlessly and, worse,
  // report success — the sweep would look like it worked.
  const paths = collectSubmissionImagePaths([], [], [{ storage_path: null }]);
  assertEquals(paths, []);
});

Deno.test("US-2645: the delete route actually reads the table", () => {
  // The collector is pure, so it passes on hand-made input whether or not the
  // route ever queries the table. This is the half that made the original bug
  // possible: the function was correct and nothing fed it.
  const src = Deno.readTextFileSync(new URL("../routes/account.ts", import.meta.url));
  assert(
    /\.from\("purchase_arrival_captures"\)[\s\S]{0,200}?\.eq\("user_id", userId\)/.test(src),
    "account.ts never selects purchase_arrival_captures for the storage sweep",
  );
  assert(
    /collectSubmissionImagePaths\([\s\S]{0,400}?arrivalRows/.test(src),
    "the rows are read but never passed to the collector",
  );
});
