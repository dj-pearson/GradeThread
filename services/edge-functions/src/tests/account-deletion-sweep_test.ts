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

// ── US-2646: the compliance export archive is the fifth source, and the worst ──
//
// processExport assembles a subject's COMPLETE account — submissions, inventory,
// listings, sales, and a storage manifest — into one file in the private
// `compliance-exports` bucket. Nothing has ever removed an object from that
// bucket. The data_requests row cascades on self-serve deletion, so the archive
// was left with nothing pointing at it.
//
// It is the most complete copy of a person that exists here, and it exists
// BECAUSE they exercised a data right. Leaving it behind when they exercise the
// other one is the sharpest version of this whole pattern.
//
// A DIFFERENT BUCKET, so this is checked separately from the collector: a test
// that only exercised collectSubmissionImagePaths would say nothing about it.

Deno.test("US-2646: the delete route sweeps the compliance-exports bucket", () => {
  const src = Deno.readTextFileSync(new URL("../routes/account.ts", import.meta.url));
  // ANCHORED ON `file_path`, NOT on the table name. account.ts also reads
  // data_requests for the self-serve INTAKE endpoint, scoped to the same
  // userId — so a table-name assertion matched that instead and passed with the
  // sweep read deleted outright. Verified: removing the sweep read left this
  // test green until the anchor moved to the column only the sweep asks for.
  assert(
    /\.from\("data_requests"\)[\s\S]{0,120}?\.select\("file_path"\)/.test(src),
    "account.ts never selects data_requests.file_path for the storage sweep",
  );
  assert(
    /exportRows\.data[\s\S]{0,200}?complianceExportPaths|complianceExportPaths[\s\S]{0,300}?exportRows\.data/
      .test(src),
    "the archive paths are read but never reach the remove call",
  );
  assert(
    /removeAll\("compliance-exports"/.test(src),
    "the export archive paths are read but never removed",
  );
  // Order matters: the paths must be gathered BEFORE the cascade destroys the
  // rows that name them. Same reason the other four are read up front.
  const gather = src.indexOf('.from("data_requests")');
  const cascade = src.indexOf("auth.admin.deleteUser");
  assert(gather > -1, "the data_requests read vanished");
  assert(
    cascade === -1 || gather < cascade,
    "the archive path must be read before the account cascade removes the row",
  );
});

Deno.test("US-2646: every bucket this account writes to is swept", () => {
  // The pattern behind US-1637, US-2645 and this one is always the same: a new
  // writer into a bucket, by an author with no reason to open a deletion
  // routine. Naming the buckets here means the next one has to argue with a
  // test rather than simply not be noticed.
  const src = Deno.readTextFileSync(new URL("../routes/account.ts", import.meta.url));
  for (const bucket of ["submission-images", "item-photos", "compliance-exports"]) {
    assert(
      src.includes(`removeAll("${bucket}"`),
      `nothing sweeps the ${bucket} bucket on account deletion`,
    );
  }
});
