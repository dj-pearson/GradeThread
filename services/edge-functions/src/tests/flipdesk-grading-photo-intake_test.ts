// US-3514: FlipDesk grading copies item photos into submission-images. It must
// refuse a photo outside the owner's folder (item_photos.storage_path is
// client-writable and is read with the service-role client from either
// bucket), and it must run the same US-276 intake as /api/grade/submit.
import { assert, assertEquals } from "@std/assert";

import { isOwnedStoragePath } from "../lib/storage-path-ownership.ts";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

Deno.test("US-3514: a path in the owner's folder is accepted", () => {
  assert(isOwnedStoragePath(`${OWNER}/item-1/front_1.webp`, OWNER));
});

Deno.test("US-3514: another tenant's path is refused", () => {
  assertEquals(isOwnedStoragePath(`${OTHER}/sub-9/front_1.jpg`, OWNER), false);
});

Deno.test("US-3514: prefix tricks and traversal are refused", () => {
  assertEquals(isOwnedStoragePath(`${OWNER}x/item/front.jpg`, OWNER), false);
  assertEquals(isOwnedStoragePath(`/${OWNER}/item/front.jpg`, OWNER), false);
  assertEquals(
    isOwnedStoragePath(`${OWNER}/../${OTHER}/sub/front.jpg`, OWNER),
    false,
  );
  assertEquals(isOwnedStoragePath(`${OWNER}/./item/front.jpg`, OWNER), false);
  assertEquals(isOwnedStoragePath(`${OWNER}/item/front.jpg`, ""), false);
});

Deno.test("US-3514: ownership is checked before the charge, intake runs in the copy loop", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/grading-submit.ts", import.meta.url),
  );
  const ownCheck = src.indexOf("isOwnedStoragePath(p.storage_path, ownerId)");
  const charge = src.indexOf("runPaymentPrecedence(\n");
  const subInsert = src.indexOf('.from("submissions")\n        .insert(');
  assert(ownCheck > 0, "ownership check missing");
  assert(
    ownCheck < subInsert && ownCheck < charge,
    "ownership must be checked before the row and the charge",
  );

  const loop = src.slice(
    src.indexOf("// 3. Copy each eligible photo into submission-images"),
  );
  const validate = loop.indexOf("validateImageUpload(rawBytes");
  const strip = loop.indexOf("stripImageMetadata(rawBytes, verdict.format)");
  const hash = loop.indexOf("computePhashFromImage(cleanBytes");
  const upload = loop.indexOf(".upload(newPath, cleanBytes");
  assert(
    validate > 0 && validate < strip && strip < hash && hash < upload,
    "copy loop must validate -> strip -> hash -> upload the stripped bytes",
  );
  assert(loop.indexOf("phash,") > 0, "submission_images row must carry phash");
});
