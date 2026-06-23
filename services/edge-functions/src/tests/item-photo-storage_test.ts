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
import {
  bucketForItemPhoto,
  ITEM_PHOTOS_BUCKET,
  SENSITIVE_ITEM_PHOTO_TYPES,
  SUBMISSION_IMAGES_BUCKET,
} from "../lib/item-photo-storage.ts";

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
