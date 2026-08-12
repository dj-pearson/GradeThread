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
// Static import is safe here even though it hoists above the env setup below:
// publish-preflight.ts is pure and its only ai-listing import is `import type`,
// so nothing touches the service-role client at load.
import { dedupeAndCapImages } from "../lib/publish-preflight.ts";

// item-photo-storage.ts imports the service-role supabase client at load, so
// set dummy env BEFORE the dynamic import (same pattern as the other tests) —
// otherwise this file only passes when an earlier suite file happened to set it.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  AI_PHOTO_SIGNED_URL_TTL_SECONDS,
  bucketForItemPhoto,
  filterListablePhotos,
  isInternalItemPhoto,
  isNonListableItemPhoto,
  ITEM_PHOTOS_BUCKET,
  itemPhotoAiUrl,
  itemPhotoAiUrls,
  publicItemPhotoUrl,
  readBucketForItemPhoto,
  SENSITIVE_ITEM_PHOTO_TYPES,
  SUBMISSION_IMAGES_BUCKET,
} = await import("../lib/item-photo-storage.ts");

/**
 * Storage double. `present` lists the paths that exist in each bucket, so a sign
 * against the wrong bucket fails the way the real API does ("Object not found").
 * Records every call so a test can assert WHICH bucket was asked.
 */
function fakeStorage(present: Record<string, string[]>) {
  const calls: string[] = [];
  return {
    calls,
    api: {
      publicUrl(bucket: string, path: string) {
        calls.push(`public:${bucket}:${path}`);
        return `https://api.gradethread.com/storage/v1/object/public/${bucket}/${path}`;
      },
      signUrl(bucket: string, path: string) {
        calls.push(`sign:${bucket}:${path}`);
        if (!(present[bucket] ?? []).includes(path)) {
          return Promise.resolve(null);
        }
        return Promise.resolve(
          `https://api.gradethread.com/storage/v1/object/sign/${bucket}/${path}?token=jwt`,
        );
      },
    },
  };
}

const SRC_DIR = new URL("../", import.meta.url);
// The resolver itself is the ONLY place allowed to call `.download` on a
// concrete bucket — exclude it from the source scan.
const ALLOWED = new Set(["lib/item-photo-storage.ts"]);

// US-2265: the URL half of the same split. Every AI photo loader used to build
// `from("item-photos").getPublicUrl(row.storage_path)` for EVERY row, so on an
// iOS-captured item the tag / tag_2 / certificate objects (PRIVATE bucket) 404'd
// and `buildPhotoContent` dropped them with only a console.warn — Size AI,
// listing generation, the tag-OCR pass and photo QA all silently ran without the
// care/size label. Reads of an `item_photos` row MUST resolve through
// `itemPhotoAiUrl`.
//
// A file-level allowlist can't express this: the same file legitimately builds a
// public URL for an object it JUST uploaded (staging blobs, the disclosure
// composite, the measure overlay), which has no private variant. So the
// exemption is per-SITE and has to state its reason inline.
const PUBLIC_URL_MARKER = "item-photo-url-ok";
// The resolver itself is the sanctioned home of the raw calls.
const PUBLIC_URL_ALLOWED_FILES = new Set(["lib/item-photo-storage.ts"]);

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

Deno.test("US-2265: no edge code builds an item-photo AI URL from a hardcoded public bucket", async () => {
  // `.from("item-photos")` … `.getPublicUrl(` — the two can sit on separate
  // lines (the formatter breaks the chain), so scan a small window around each
  // getPublicUrl for the bucket, and for the inline exemption marker.
  const offenders: string[] = [];
  for (const rel of await tsFiles(SRC_DIR)) {
    if (rel.startsWith("tests/") || PUBLIC_URL_ALLOWED_FILES.has(rel)) continue;
    const lines = (await Deno.readTextFile(new URL(rel, SRC_DIR))).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(".getPublicUrl(")) continue;
      // The bucket sits in the same chain, so a tight look-back finds it...
      const chain = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
      if (!/\.from\(\s*["']item-photos["']\s*\)/.test(chain)) continue;
      // ...while the exemption marker is a comment ABOVE the statement and may
      // run to a few explanatory lines, so give it a wider window.
      const withComment = lines.slice(Math.max(0, i - 10), i + 1).join("\n");
      if (withComment.includes(PUBLIC_URL_MARKER)) continue;
      offenders.push(`${rel}:${i + 1}`);
    }
  }
  assert(
    offenders.length === 0,
    `These sites build an item-photo URL from the hardcoded public bucket. ` +
      `If the path came from an item_photos ROW, use itemPhotoAiUrl() so a ` +
      `private-bucket (iOS) tag photo resolves. If it is an object you just ` +
      `uploaded to the public bucket, add a "// ${PUBLIC_URL_MARKER}: <reason>" ` +
      `comment above the statement: ${offenders.join(", ")}`,
  );
});

Deno.test("US-2265: readBucketForItemPhoto reads the stored photo_url, nothing else", () => {
  // iOS writes photo_url as "" for exactly its private-bucket uploads.
  assertEquals(readBucketForItemPhoto(""), SUBMISSION_IMAGES_BUCKET);
  assertEquals(readBucketForItemPhoto("   "), SUBMISSION_IMAGES_BUCKET);
  assertEquals(readBucketForItemPhoto(null), SUBMISSION_IMAGES_BUCKET);
  assertEquals(readBucketForItemPhoto(undefined), SUBMISSION_IMAGES_BUCKET);
  // A populated URL means the bytes ARE public: web uploads every type to
  // item-photos, and so did pre-US-979 iOS builds. Signing the private bucket
  // for those mints a token for an object that isn't there.
  assertEquals(
    readBucketForItemPhoto(
      "https://api.gradethread.com/storage/v1/object/public/item-photos/u/i/tag_1.jpg",
    ),
    ITEM_PHOTOS_BUCKET,
  );
});

// US-2407: the answer must not move when the seller changes the type dropdown.
// It used to: the empty-photo_url case was routed by TYPE, so retagging a
// phone-captured Garment Tag to "Front" pointed every edge reader at the public
// bucket for bytes that had never been there — an AI pass that silently skipped
// the photo, and a marketplace payload carrying a URL that 404s. A retag
// relabels a row; it does not move an object.
Deno.test("US-2407: a retagged private photo stays private to every edge reader", async () => {
  const path = "owner/item/tag_1.jpg";
  const store = fakeStorage({ "submission-images": [path] });

  for (const retaggedTo of ["front", "back", "detail", "flatlay"]) {
    const row = { storage_path: path, photo_type: retaggedTo, photo_url: "" };

    // The AI passes still reach the bytes...
    const aiUrl = await itemPhotoAiUrl(row, store.api);
    assert(
      aiUrl?.includes(`/object/sign/${SUBMISSION_IMAGES_BUCKET}/`),
      `retagged to ${retaggedTo}: expected a signed private URL, got ${aiUrl}`,
    );

    // ...and no marketplace gets a public URL for an object that isn't public.
    assertEquals(
      publicItemPhotoUrl(row),
      null,
      `retagged to ${retaggedTo}: a private photo must never publish`,
    );
  }
});

Deno.test("US-2265: the AI signed-URL TTL stays inside the 900s storage rule", () => {
  assert(AI_PHOTO_SIGNED_URL_TTL_SECONDS > 0);
  assert(
    AI_PHOTO_SIGNED_URL_TTL_SECONDS <= 900,
    "CLAUDE.md caps submission-images signed URLs at 900s",
  );
  // Mirrors iOS PhotoStorageBucket.signedURLTTLSeconds so both clients expire
  // an AI-pass URL on the same schedule.
  assertEquals(AI_PHOTO_SIGNED_URL_TTL_SECONDS, 600);
});

Deno.test("US-2265: itemPhotoAiUrl signs an iOS tag photo and leaves listing imagery public", async () => {
  const tagPath = "owner/item/tag_1.jpg";
  const frontPath = "owner/item/front_1.jpg";
  const store = fakeStorage({ "submission-images": [tagPath] });

  // iOS capture: sensitive type, photo_url written as "" → PRIVATE bucket.
  for (const type of SENSITIVE_ITEM_PHOTO_TYPES) {
    const url = await itemPhotoAiUrl(
      { storage_path: tagPath, photo_type: type, photo_url: "" },
      store.api,
    );
    assert(
      url?.includes(`/object/sign/${SUBMISSION_IMAGES_BUCKET}/`),
      `${type} must resolve to a signed private-bucket URL, got ${url}`,
    );
    assert(url?.includes("token="), "a signed URL carries its token");
  }

  // Listing imagery: public URL, no sign round trip.
  const front = await itemPhotoAiUrl(
    { storage_path: frontPath, photo_type: "front", photo_url: "" },
    store.api,
  );
  assertEquals(
    front,
    `https://api.gradethread.com/storage/v1/object/public/${ITEM_PHOTOS_BUCKET}/${frontPath}`,
  );
  assert(
    !store.calls.some((c) => c === `sign:${ITEM_PHOTOS_BUCKET}:${frontPath}`),
    "a public photo must not cost a signing round trip",
  );

  // A row with no storage_path can't be resolved at all.
  assertEquals(await itemPhotoAiUrl({ storage_path: null, photo_type: "tag" }, store.api), null);
  assertEquals(await itemPhotoAiUrl({ storage_path: "  ", photo_type: "tag" }, store.api), null);
});

Deno.test("US-2265: a web-uploaded tag (public bucket, populated photo_url) stays public", async () => {
  const path = "owner/item/tag_1.jpg";
  // Nothing in submission-images: signing there would fail, which is exactly the
  // bug the photo_url signal avoids paying for.
  const store = fakeStorage({});
  const url = await itemPhotoAiUrl(
    {
      storage_path: path,
      photo_type: "tag",
      photo_url:
        `https://api.gradethread.com/storage/v1/object/public/item-photos/${path}`,
    },
    store.api,
  );
  assertEquals(
    url,
    `https://api.gradethread.com/storage/v1/object/public/${ITEM_PHOTOS_BUCKET}/${path}`,
  );
  assertEquals(store.calls, [`public:${ITEM_PHOTOS_BUCKET}:${path}`]);
});

Deno.test("US-2265: a sensitive row whose blob is public falls back instead of dropping", async () => {
  // Pre-US-979 iOS build, or a photo reclassified to `tag` after capture: the
  // row looks private (empty photo_url) but the bytes are in item-photos.
  const path = "owner/item/tag_legacy.jpg";
  const store = fakeStorage({});
  const url = await itemPhotoAiUrl(
    { storage_path: path, photo_type: "tag", photo_url: "" },
    store.api,
  );
  assertEquals(
    url,
    `https://api.gradethread.com/storage/v1/object/public/${ITEM_PHOTOS_BUCKET}/${path}`,
  );
  // It TRIED the private bucket first, then degraded to today's behaviour.
  assertEquals(store.calls[0], `sign:${SUBMISSION_IMAGES_BUCKET}:${path}`);
});

// The regression this story exists for: the /size + listing-generation photo
// loaders fed the model a public URL for an iOS tag photo, which 404s, and
// buildPhotoContent skips a non-2xx image with only a console.warn. So the AI
// read the garment WITHOUT its care/size label on every iOS-sourced item, while
// the same item captured on web kept it.
Deno.test("US-2265: an iOS item's tag photo survives the loader's URL resolution", async () => {
  const rows = [
    { storage_path: "o/i/front_1.jpg", photo_type: "front", photo_url: "https://pub/front" },
    { storage_path: "o/i/tag_1.jpg", photo_type: "tag", photo_url: "" },
    { storage_path: "o/i/back_1.jpg", photo_type: "back", photo_url: "https://pub/back" },
  ];
  const store = fakeStorage({ "submission-images": ["o/i/tag_1.jpg"] });
  const resolved = await itemPhotoAiUrls(rows, store.api);

  // Nothing dropped, and sort order preserved (selectListingPhotos + the cover
  // photo both depend on position).
  assertEquals(resolved.map((r) => r.row.photo_type), ["front", "tag", "back"]);
  const tag = resolved.find((r) => r.row.photo_type === "tag");
  assert(
    tag?.url.includes(`/object/sign/${SUBMISSION_IMAGES_BUCKET}/`),
    "the tag photo must reach the model as a signed private-bucket URL",
  );
});

// US-2271: the counterpart rule for PUBLIC destinations. Depop/Etsy/Shopify built
// `getPublicUrl(storage_path)` for every row with no sensitivity check at all, so
// a web-captured care label (populated photo_url) was published as listing
// imagery and an iOS-captured one was pushed as a URL that 404s. eBay's resolver
// had the rule; the adapters had drifted. Now there is one.
Deno.test("US-2271: publicItemPhotoUrl refuses a private-bucket sensitive photo", () => {
  for (const type of SENSITIVE_ITEM_PHOTO_TYPES) {
    // Empty photo_url + sensitive type = the bytes are private. Never publish.
    assertEquals(
      publicItemPhotoUrl({ storage_path: "o/i/tag_1.jpg", photo_type: type, photo_url: "" }),
      null,
    );
    assertEquals(
      publicItemPhotoUrl({ storage_path: "o/i/tag_1.jpg", photo_type: type, photo_url: null }),
      null,
    );
    // A stored public URL keeps working — web has always uploaded every type to
    // the public bucket and live listings point at those URLs.
    assertEquals(
      publicItemPhotoUrl({
        storage_path: "o/i/tag_1.jpg",
        photo_type: type,
        photo_url: "https://cdn.example/tag_1.jpg",
      }),
      "https://cdn.example/tag_1.jpg",
    );
  }

  // US-2407: listing imagery with NO stored URL is refused too. It used to be
  // minted from the public bucket, on the theory that a non-sensitive type means
  // public bytes — but the type is the seller's dropdown, and retagging a
  // private photo to "Front" walked straight through that door and put a 404 URL
  // in an eBay gallery. Nothing legitimate is lost: every writer that puts an
  // object in item-photos stores its URL on the row in the same insert, so
  // "empty photo_url + public bytes" is not a shape this codebase produces.
  assertEquals(
    publicItemPhotoUrl({
      storage_path: "o/i/front_1.jpg",
      photo_type: "front",
      photo_url: "",
    }),
    null,
  );

  // Nothing to resolve at all.
  assertEquals(publicItemPhotoUrl({ storage_path: null, photo_type: "front" }), null);
  assertEquals(publicItemPhotoUrl({ storage_path: "   ", photo_type: "front" }), null);
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

// US-2462: migration 00587 rewrites measurement_chest → (measurement, 'chest').
// 'measurement' is on NON_LISTABLE_PHOTO_TYPES, so without a role-aware rule
// that backfill would have pulled every seller's tape photos out of their live
// listings — silently, because nothing errors when a photo is merely filtered.
Deno.test("US-2462: a measurement WITH a role is a tape photo and still lists", () => {
  // The card frame: a branded foreign object, never lists. This is also the
  // shape of every pre-00587 row, so history is preserved by the NULL case.
  assert(isNonListableItemPhoto("measurement", null));
  assert(isNonListableItemPhoto("measurement", undefined));
  assert(isNonListableItemPhoto("measurement"));

  // The tape close-ups, post-backfill. These are what measurement_chest and
  // friends became, and they were listable before.
  assert(!isNonListableItemPhoto("measurement", "chest"));
  assert(!isNonListableItemPhoto("measurement", "inseam"));

  // A role changes nothing for any other type — 'internal' is unconditional.
  assert(isNonListableItemPhoto("internal", "fabric"));
  assert(!isNonListableItemPhoto("detail", "fabric"));
  assert(!isNonListableItemPhoto("front", null));

  const rows = [
    { id: "a", photo_type: "front", photo_role: null },
    { id: "b", photo_type: "measurement", photo_role: null }, // card frame
    { id: "c", photo_type: "measurement", photo_role: "chest" }, // tape shot
    { id: "d", photo_type: "internal", photo_role: null },
    { id: "e", photo_type: "detail", photo_role: "fabric" },
  ];
  assertEquals(filterListablePhotos(rows).map((r) => r.id), ["a", "c", "e"]);
});

// The trap this pins: `photo_role` absent from a SELECT reads as undefined,
// which is indistinguishable from a NULL role, which means "card frame". So a
// query that forgets the column drops the seller's tape photos and reports
// nothing. Every call site was updated in the same commit; this is the guard
// that explains why if one is ever added back.
Deno.test("US-2462: a row missing photo_role is treated as the card frame", () => {
  const rows = [
    { id: "a", photo_type: "front" },
    { id: "b", photo_type: "measurement" },
  ];
  assertEquals(filterListablePhotos(rows).map((r) => r.id), ["a"]);
});

// Every path that publishes an item photo to a PUBLIC destination must exclude
// the sensitive types. The private-bucket source is only half the protection:
// downloadItemPhoto deliberately resolves across BOTH buckets, so any consumer
// that re-publishes what it downloads can launder a private photo into a public
// URL without touching the bucket logic at all.
//
// That is exactly what /api/flipdesk/images/archive did — it selected every
// item_photos row for the owner, downloaded each (private originals included),
// PUT it to R2 and rewrote photo_url to r2PublicUrl(), an unauthenticated URL.
// bg-remove, the eBay push and the thumbnail backfill all filtered these types;
// archival was the one consumer that didn't.
Deno.test("R2 archival excludes sensitive photo types (public-URL leak guard)", async () => {
  const src = await Deno.readTextFile(new URL("routes/flipdesk-images.ts", SRC_DIR));

  // The archival query must filter them out server-side...
  assert(
    /\.not\(\s*"photo_type",\s*"in",/.test(src),
    "flipdesk-images.ts archival must exclude SENSITIVE_ITEM_PHOTO_TYPES in the " +
      "eligibility query — otherwise private tag/certificate photos are copied " +
      "to a public R2 URL.",
  );

  // ...AND the publishing loop must re-check at the point of harm, so a future
  // edit to the query cannot reintroduce the leak silently.
  assert(
    /SENSITIVE_ITEM_PHOTO_TYPES\.has\(p\.photo_type \?\? ""\)\s*\)\s*continue;/.test(src),
    "The archival loop must skip sensitive photo types defensively before " +
      "uploading to R2 — the query filter alone is one edit away from leaking.",
  );
});

// ── US-2501: duplicate TAGS publish; only internal/frame/private are held back ─
//
// The composer's per-tag slot grid is gone, and with it the last surface that
// implied "one photo per tag" — each tile rendered `photos[0]` and a "×N", so
// three fabric close-ups looked like one. Sellers publish several shots of the
// same thing on purpose (four defects, two fabric macros, both sleeves), and
// nothing in the publish path has ever deduped by tag. This pins that, because
// "collapse same-tag photos" is a plausible-sounding optimisation that would
// silently delete photos from live listings.
//
// The composition under test is the real one every publish path runs:
//   filterListablePhotos → publicItemPhotoUrl → dedupeAndCapImages
Deno.test("US-2501: several photos sharing one tag all reach the marketplace", () => {
  const rows = [
    { id: "f1", photo_type: "front", photo_role: null, photo_url: "https://cdn/f1.webp", storage_path: "u/i/f1.webp" },
    { id: "f2", photo_type: "front", photo_role: null, photo_url: "https://cdn/f2.webp", storage_path: "u/i/f2.webp" },
    { id: "d1", photo_type: "detail", photo_role: "fabric", photo_url: "https://cdn/d1.webp", storage_path: "u/i/d1.webp" },
    { id: "d2", photo_type: "detail", photo_role: "fabric", photo_url: "https://cdn/d2.webp", storage_path: "u/i/d2.webp" },
    { id: "d3", photo_type: "detail", photo_role: "fabric", photo_url: "https://cdn/d3.webp", storage_path: "u/i/d3.webp" },
    { id: "x1", photo_type: "defect", photo_role: null, photo_url: "https://cdn/x1.webp", storage_path: "u/i/x1.webp" },
    { id: "x2", photo_type: "defect", photo_role: null, photo_url: "https://cdn/x2.webp", storage_path: "u/i/x2.webp" },
  ];

  const listable = filterListablePhotos(rows);
  assertEquals(
    listable.map((r) => r.id),
    ["f1", "f2", "d1", "d2", "d3", "x1", "x2"],
    "filterListablePhotos judges each row on its own tag — it is not a set operation",
  );

  const { urls, duplicatesRemoved } = dedupeAndCapImages(
    listable.map(publicItemPhotoUrl),
  );
  assertEquals(urls.length, 7);
  assertEquals(duplicatesRemoved, 0, "same tag, different photos: nothing to de-dup");
});

// The exclusions are per-row too, so a seller with four receipts loses four
// photos from the listing and keeps four in the app — not "one internal photo
// is filtered and the rest slip through", and not "an internal photo present at
// all suppresses the tag".
Deno.test("US-2501: repeated internal / card-frame tags are each held back", () => {
  const rows = [
    { id: "a", photo_type: "front", photo_role: null, photo_url: "https://cdn/a.webp", storage_path: "u/i/a.webp" },
    { id: "r1", photo_type: "internal", photo_role: null, photo_url: "https://cdn/r1.webp", storage_path: "u/i/r1.webp" },
    { id: "r2", photo_type: "internal", photo_role: null, photo_url: "https://cdn/r2.webp", storage_path: "u/i/r2.webp" },
    { id: "m1", photo_type: "measurement", photo_role: null, photo_url: "https://cdn/m1.webp", storage_path: "u/i/m1.webp" },
    { id: "m2", photo_type: "measurement", photo_role: null, photo_url: "https://cdn/m2.webp", storage_path: "u/i/m2.webp" },
    // ...while repeated TAPE shots (a role is present) are ordinary photos.
    { id: "t1", photo_type: "measurement", photo_role: "chest", photo_url: "https://cdn/t1.webp", storage_path: "u/i/t1.webp" },
    { id: "t2", photo_type: "measurement", photo_role: "sleeve", photo_url: "https://cdn/t2.webp", storage_path: "u/i/t2.webp" },
  ];
  assertEquals(filterListablePhotos(rows).map((r) => r.id), ["a", "t1", "t2"]);
});

// The one thing that IS collapsed is the same FILE listed twice — that is an
// eBay 25601 waiting to happen, and it is keyed on the URL, never on the tag.
Deno.test("US-2501: de-dup keys on the image URL, not the photo tag", () => {
  const { urls, duplicatesRemoved } = dedupeAndCapImages([
    "https://cdn/same.webp",
    "https://cdn/same.webp",
    "https://cdn/other.webp",
  ]);
  assertEquals(urls, ["https://cdn/same.webp", "https://cdn/other.webp"]);
  assertEquals(duplicatesRemoved, 1);
});
