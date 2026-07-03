// US-979 regression guard. Sensitive item photos (size/care labels, second
// tags, grading certs) live in the PRIVATE `submission-images` bucket on iOS
// but the public `item-photos` bucket on web. Downloading from a single
// hardcoded bucket fails with "object not found" for a photo written by the
// other client (the real grading-submit bug). All edge code MUST download item
// photos via `downloadItemPhoto` (which looks in both buckets) — never
// `supabaseAdmin.storage.from("item-photos").download(...)` directly.
//
// This is a source-guard (grep-style) plus a unit test of the bucket selection.
import { assert, assertEquals } from "@std/assert";

// item-photo-storage.ts imports the service-role supabase client at load, so
// set dummy env BEFORE the dynamic import (same pattern as the other tests) —
// otherwise this file only passes when an earlier suite file happened to set it.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  bucketForItemPhoto,
  filterListablePhotos,
  isInternalItemPhoto,
  isNonListableItemPhoto,
  ITEM_PHOTOS_BUCKET,
  SENSITIVE_ITEM_PHOTO_TYPES,
  SUBMISSION_IMAGES_BUCKET,
} = await import("../lib/item-photo-storage.ts");

const SRC_DIR = new URL("../", import.meta.url);
// The resolver itself is the ONLY place allowed to call `.download` on a
// concrete bucket — exclude it from the source scan.
const ALLOWED = new Set(["lib/item-photo-storage.ts"]);

async function tsFiles(dir: URL, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      out.push(...(await tsFiles(new URL(`${entry.name}/`, dir), rel)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(rel);
    }
  }
  return out;
}

Deno.test("no edge code downloads item-photos from a single hardcoded bucket", async () => {
  // Matches `.from("item-photos").download(` across line breaks/whitespace.
  const re = /\.from\(\s*["']item-photos["']\s*\)\s*\.download\s*\(/;
  const offenders: string[] = [];
  for (const rel of await tsFiles(SRC_DIR)) {
    // Scan shipping code only; tests/ may reference the anti-pattern in
    // comments/fixtures, and the resolver itself is the sanctioned exception.
    if (rel.startsWith("tests/") || ALLOWED.has(rel)) continue;
    const src = await Deno.readTextFile(new URL(rel, SRC_DIR));
    if (re.test(src)) offenders.push(rel);
  }
  assert(
    offenders.length === 0,
    `These files download item photos from a hardcoded bucket — use ` +
      `downloadItemPhoto() instead: ${offenders.join(", ")}`,
  );
});

Deno.test("bucketForItemPhoto routes sensitive types to the private bucket", () => {
  for (const t of SENSITIVE_ITEM_PHOTO_TYPES) {
    assertEquals(bucketForItemPhoto(t), SUBMISSION_IMAGES_BUCKET);
  }
  assertEquals(bucketForItemPhoto("front"), ITEM_PHOTOS_BUCKET);
  assertEquals(bucketForItemPhoto(null), ITEM_PHOTOS_BUCKET);
  assertEquals(bucketForItemPhoto(undefined), ITEM_PHOTOS_BUCKET);
  // The exact set the iOS client mirrors (PhotoStorageBucket.sensitiveServerTypes).
  assertEquals(
    [...SENSITIVE_ITEM_PHOTO_TYPES].sort(),
    ["certificate", "tag", "tag_2"],
  );
});

// US-1549: 'internal' photos are seller-reference only — every eBay/AI/public
// photo selection filters them via filterListablePhotos.
Deno.test("US-1549: internal photos are excluded by filterListablePhotos", () => {
  assert(isInternalItemPhoto("internal"));
  assert(!isInternalItemPhoto("front"));
  assert(!isInternalItemPhoto(null));
  assert(!isInternalItemPhoto(undefined));

  const rows = [
    { id: "a", photo_type: "front" },
    { id: "b", photo_type: "internal" },
    { id: "c", photo_type: null },
    { id: "d", photo_type: "detail" },
  ];
  assertEquals(filterListablePhotos(rows).map((r) => r.id), ["a", "c", "d"]);
  // NOT bucket-sensitive: the blob stays wherever it was uploaded — the
  // enforcement is selection-side, by design.
  assertEquals(bucketForItemPhoto("internal"), ITEM_PHOTOS_BUCKET);
});

Deno.test("US-1571: measurement (MeasureCard) photos are excluded like internal", () => {
  assert(isNonListableItemPhoto("measurement"));
  assert(isNonListableItemPhoto("internal"));
  assert(!isNonListableItemPhoto("front"));
  // The tape-measure close-ups are NOT the card frame - they stay listable.
  assert(!isNonListableItemPhoto("measurement_chest"));
  assert(!isNonListableItemPhoto(null));

  const rows = [
    { id: "a", photo_type: "front" },
    { id: "b", photo_type: "measurement" },
    { id: "c", photo_type: "measurement_length" },
    { id: "d", photo_type: "internal" },
  ];
  // The publish/AI/public selection keeps only a + c.
  assertEquals(filterListablePhotos(rows).map((r) => r.id), ["a", "c"]);
  // isInternalItemPhoto stays narrow (bucket/other semantics unchanged).
  assert(!isInternalItemPhoto("measurement"));
  assertEquals(bucketForItemPhoto("measurement"), ITEM_PHOTOS_BUCKET);
});
