import { assertEquals } from "@std/assert";
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
