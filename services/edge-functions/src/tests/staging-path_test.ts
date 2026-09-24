// AL-02: the one strict staging-path check. A bare startsWith accepted
// `owner/_staging/../../victim/x.jpg`, which storage normalises into another
// tenant's folder.
import "./_env.ts";
import { assertEquals } from "@std/assert";
import { isOwnedStagingPath, isOwnedStoragePath } from "../lib/staging-path.ts";
import { itemPhotoAiUrl, type ItemPhotoStorageApi } from "../lib/item-photo-storage.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const VICTIM = "22222222-2222-4222-8222-222222222222";

Deno.test("paths the app writes itself are accepted", () => {
  for (
    const p of [
      `${OWNER}/_staging/sess-1234/abc.jpg`,
      `${OWNER}/_staging/phone/9f1c.webp`,
      `${OWNER}/_staging/gphotos/originals/x.jpg`,
      `${OWNER}/_staging/receipt_1726000000000.png`,
    ]
  ) {
    assertEquals(isOwnedStagingPath(p, OWNER), true, p);
  }
});

Deno.test("traversal and smuggling shapes are refused", () => {
  for (
    const p of [
      `${OWNER}/_staging/../../${VICTIM}/_staging/x.jpg`,
      `${OWNER}/_staging/%2e%2e/%2e%2e/${VICTIM}/x.jpg`,
      `${OWNER}/_staging/%252e%252e/x.jpg`,
      `${OWNER}/_staging/./x.jpg`,
      `${OWNER}/_staging//x.jpg`,
      `${OWNER}/_staging/x.jpg/`,
      `${OWNER}/_staging/`,
      `${OWNER}/_staging/..\\..\\${VICTIM}\\x.jpg`,
      `${OWNER}/_staging/x.jpg?download=1`,
      `${OWNER}/_staging/x.jpg#frag`,
      `${OWNER}/_staging/x\u0000.jpg`,
      `${OWNER}/other/x.jpg`,
      `${VICTIM}/_staging/x.jpg`,
      `${OWNER}x/_staging/x.jpg`,
    ]
  ) {
    assertEquals(isOwnedStagingPath(p, OWNER), false, JSON.stringify(p));
  }
});

Deno.test("non-strings and empty owners are refused", () => {
  assertEquals(isOwnedStagingPath(undefined, OWNER), false);
  assertEquals(isOwnedStagingPath(42, OWNER), false);
  assertEquals(isOwnedStagingPath("/_staging/x.jpg", ""), false);
  assertEquals(isOwnedStagingPath(`a/b/_staging/x.jpg`, "a/b"), false);
});

Deno.test("isOwnedStoragePath accepts the owner's folder and nothing that leaves it", () => {
  assertEquals(isOwnedStoragePath(`${OWNER}/item-1/front_1.jpg`, OWNER), true);
  assertEquals(isOwnedStoragePath(`${OWNER}/../${VICTIM}/label.jpg`, OWNER), false);
  assertEquals(isOwnedStoragePath(`${VICTIM}/item-1/label.jpg`, OWNER), false);
});

function recordingStorage() {
  const signed: string[] = [];
  const api: ItemPhotoStorageApi = {
    publicUrl: (bucket, path) => `https://public/${bucket}/${path}`,
    signUrl: (bucket, path) => {
      signed.push(`${bucket}/${path}`);
      return Promise.resolve(`https://signed/${bucket}/${path}`);
    },
  };
  return { api, signed };
}

Deno.test("itemPhotoAiUrl refuses to sign a foreign storage_path when the owner is known", async () => {
  // A forged item_photos row on the owner's own item, pointing at another
  // seller's private grading label.
  const { api, signed } = recordingStorage();
  const url = await itemPhotoAiUrl(
    { storage_path: `${VICTIM}/sub-1/label_1.jpg`, photo_type: "tag", photo_url: null },
    api,
    { ownerId: OWNER },
  );
  assertEquals(url, null);
  assertEquals(signed, []);
});

Deno.test("itemPhotoAiUrl still signs the owner's own private photo", async () => {
  const { api, signed } = recordingStorage();
  const url = await itemPhotoAiUrl(
    { storage_path: `${OWNER}/item-1/tag_1.jpg`, photo_type: "tag", photo_url: null },
    api,
    { ownerId: OWNER },
  );
  assertEquals(typeof url, "string");
  assertEquals(signed.length, 1);
});
