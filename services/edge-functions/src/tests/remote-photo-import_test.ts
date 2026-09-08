// US-3157: the shared remote photo import core.
//
// Every case here is about ONE FILE going wrong without taking the run with it,
// because that is the behaviour the four providers on top of this module share
// and the one a copy-paste would eventually lose. There is no Supabase, no env
// and no network: storage and fetch are both passed in, which is the point of
// the module taking them.

import { assert, assertEquals } from "@std/assert";
import {
  importRemotePhotos,
  type PhotoStaging,
  planImportChunk,
  type RemotePhotoFile,
} from "../lib/remote-photo-import.ts";

/** A 4x4 PNG: signature, IHDR, IEND. Enough to pass the magic-byte sniff. */
function pngBytes(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

/** Not an image at all. A PDF is the realistic version of this mistake. */
function pdfBytes(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.7\n% not a photograph\n");
}

interface Recorder {
  storage: PhotoStaging;
  uploads: string[];
}

function recordingStorage(fail?: (path: string) => string | null): Recorder {
  const uploads: string[] = [];
  return {
    uploads,
    storage: {
      upload(path) {
        const message = fail?.(path) ?? null;
        if (message) return Promise.resolve({ error: { message } });
        uploads.push(path);
        return Promise.resolve({ error: null });
      },
      publicUrl(path) {
        return `https://cdn.example.test/${path}`;
      },
    },
  };
}

function file(id: string, url: string): RemotePhotoFile {
  return { id, url, headers: { Authorization: "Bearer t" }, capturedAtMs: 1000 };
}

const ALLOW = (host: string) => host === "photos.example.test";

function fetchServing(map: Record<string, Uint8Array>, seen: string[]): typeof fetch {
  return (input) => {
    const url = String(input);
    seen.push(url);
    const body = map[url];
    if (!body) return Promise.resolve(new Response("gone", { status: 404 }));
    // Copy into a plain ArrayBuffer: Response takes a BodyInit, and a
    // Uint8Array over a possibly-shared buffer is not one under Deno's lib.
    const buf = new ArrayBuffer(body.length);
    new Uint8Array(buf).set(body);
    return Promise.resolve(new Response(buf, { status: 200 }));
  };
}

Deno.test("one unreadable file is skipped and the rest of the run still imports", async () => {
  const good = "https://photos.example.test/a.png";
  const bad = "https://photos.example.test/b.pdf";
  const alsoGood = "https://photos.example.test/c.png";
  const seen: string[] = [];
  const rec = recordingStorage();

  const result = await importRemotePhotos(
    [file("a", good), file("b", bad), file("c", alsoGood)],
    {
      ownerId: "owner-1",
      stagingKey: "gdrive",
      storage: rec.storage,
      allowHost: ALLOW,
      fetchFn: fetchServing({ [good]: pngBytes(), [bad]: pdfBytes(), [alsoGood]: pngBytes() }, seen),
    },
  );

  assertEquals(result.photos.length, 2);
  assertEquals(result.failures.length, 1);
  // The failure names the file, so a seller can be told WHICH photo did not come
  // through rather than that "an error occurred".
  assertEquals(result.failures[0]?.id, "b");
  assert(result.failures[0]!.reason.length > 0);
  assertEquals(rec.uploads.length, 2);
});

Deno.test("a download host the provider does not own is refused before any fetch", async () => {
  const seen: string[] = [];
  const rec = recordingStorage();
  const evil = "https://attacker.example.com/steal.png";

  const result = await importRemotePhotos([file("evil", evil)], {
    ownerId: "owner-1",
    stagingKey: "gphotos",
    storage: rec.storage,
    allowHost: ALLOW,
    fetchFn: fetchServing({ [evil]: pngBytes() }, seen),
  });

  assertEquals(result.photos.length, 0);
  assertEquals(result.failures.length, 1);
  // The bearer token rides on the download, so the check has to happen BEFORE
  // the request is made, not after the response comes back (US-579).
  assertEquals(seen.length, 0);
  assert(!result.failures[0]!.reason.includes("attacker.example.com"));
});

Deno.test("a malformed url fails that file rather than throwing out of the run", async () => {
  const good = "https://photos.example.test/a.png";
  const seen: string[] = [];
  const rec = recordingStorage();

  const result = await importRemotePhotos(
    [file("junk", "not a url at all"), file("a", good), { id: "empty", url: "" }],
    {
      ownerId: "owner-1",
      stagingKey: "dropbox",
      storage: rec.storage,
      allowHost: ALLOW,
      fetchFn: fetchServing({ [good]: pngBytes() }, seen),
    },
  );

  assertEquals(result.photos.length, 1);
  assertEquals(result.failures.map((f) => f.id).sort(), ["empty", "junk"]);
});

Deno.test("a storage failure is one file's failure, not the run's", async () => {
  const a = "https://photos.example.test/a.png";
  const b = "https://photos.example.test/b.png";
  const seen: string[] = [];
  const rec = recordingStorage((path) => (path.endsWith(".png") && rec.uploads.length === 1 ? "bucket said no" : null));

  const result = await importRemotePhotos([file("a", a), file("b", b)], {
    ownerId: "owner-1",
    stagingKey: "onedrive",
    storage: rec.storage,
    allowHost: ALLOW,
    fetchFn: fetchServing({ [a]: pngBytes(), [b]: pngBytes() }, seen),
    concurrency: 1,
  });

  assertEquals(result.photos.length, 1);
  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0]?.reason, "bucket said no");
});

Deno.test("staged photos land under the owner's folder, which is what storage RLS reads", async () => {
  const a = "https://photos.example.test/a.png";
  const seen: string[] = [];
  const rec = recordingStorage();

  const result = await importRemotePhotos([file("a", a)], {
    ownerId: "owner-42",
    stagingKey: "gdrive",
    storage: rec.storage,
    allowHost: ALLOW,
    fetchFn: fetchServing({ [a]: pngBytes() }, seen),
  });

  const photo = result.photos[0]!;
  assert(photo.storagePath.startsWith("owner-42/_staging/gdrive/"));
  assert(photo.storagePath.endsWith(".png"));
  assertEquals(photo.url, `https://cdn.example.test/${photo.storagePath}`);
  assertEquals(photo.capturedAtMs, 1000);
  assertEquals(photo.width, 4);
  assertEquals(photo.height, 4);
});

Deno.test("the chunk cursor is the same one the Google Photos import always used", () => {
  // planImportChunk moved here in US-3157; these mirror the assertions in
  // google-photos_test.ts so a change to the shared copy cannot pass by
  // breaking only the provider that no longer owns it.
  const first = planImportChunk(200, 0, undefined);
  assertEquals(first.offset, 0);
  assertEquals(first.done, false);
  assertEquals(planImportChunk(10, 10, 25).done, true);
  assertEquals(planImportChunk(0, 0, 25).done, true);
  const greedy = planImportChunk(200, 0, 500);
  assert(greedy.end - greedy.offset <= 40);
});
