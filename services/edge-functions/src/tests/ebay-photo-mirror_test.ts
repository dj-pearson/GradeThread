// US-3196: the eBay photo mirror's decisions.
//
// Pure module, so this runs with no env, no network and no database. What it
// pins is the three things that would be expensive to get wrong: which URLs are
// allowed to become a photo at all, that the same picture at two eBay sizes is
// ONE photo, and that a sync never appends to a photo set the seller owns.

// US-2379: publicItemPhotoUrl comes from item-photo-storage.ts, which reaches
// lib/supabase.ts through its static imports and reads env at module load. The
// env shim has to be the FIRST import or the module graph is built before it.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  isEbayPhotoUrl,
  MAX_MIRRORED_PHOTOS,
  normalizeEbayPictureUrls,
  planPhotoMirror,
  thumbnailEbayPictureUrl,
  upgradeEbayPictureUrl,
} from "../lib/ebay-photo-mirror.ts";
import { publicItemPhotoUrl } from "../lib/item-photo-storage.ts";

const FULL = "https://i.ebayimg.com/images/g/AbCdEfGh/s-l1600.jpg";
const THUMB = "https://i.ebayimg.com/thumbs/images/g/AbCdEfGh/s-l140.jpg";

Deno.test("only eBay's own CDN may become a photo", () => {
  assert(isEbayPhotoUrl(FULL));
  assert(isEbayPhotoUrl("https://securepictures.ebaystatic.com/x/y.jpg"));
  // A lookalike host must not pass — endsWith on a bare domain would.
  assert(!isEbayPhotoUrl("https://notebayimg.com/a.jpg"));
  assert(!isEbayPhotoUrl("https://evil.example.com/i.ebayimg.com/a.jpg"));
  // http is refused outright: these URLs are rendered in the seller's browser.
  assert(!isEbayPhotoUrl("http://i.ebayimg.com/images/g/A/s-l1600.jpg"));
  assert(!isEbayPhotoUrl("not a url"));
});

Deno.test("a thumbnail and its full-size twin are the SAME picture", () => {
  // This is the whole reason the upgrade runs before the dedupe. ActiveList
  // hands back the 140px gallery render and GetItem hands back the 1600px one;
  // without the rewrite an item would carry the same photo twice, and the hero
  // would be a thumbnail.
  assertEquals(upgradeEbayPictureUrl(THUMB), FULL);
  assertEquals(normalizeEbayPictureUrls([FULL, THUMB]), [FULL]);
  assertEquals(normalizeEbayPictureUrls([THUMB, FULL]), [FULL]);
});

Deno.test("the pre-2015 URL form is left alone", () => {
  // $_57 is already the largest variant of that shape; rewriting it would
  // produce a URL eBay does not serve.
  const legacy = "https://i.ebayimg.com/00/s/MTYwMFgxMjAw/z/abc/$_57.JPG";
  assertEquals(upgradeEbayPictureUrl(legacy), legacy);
  assertEquals(normalizeEbayPictureUrls(legacy), [legacy]);
});

Deno.test("normalize copes with every shape eBay actually returns", () => {
  // A one-picture listing returns a bare string from the XML parser; a
  // multi-picture one returns an array; an element with attributes arrives as
  // { "#text": … }.
  assertEquals(normalizeEbayPictureUrls(FULL), [FULL]);
  assertEquals(normalizeEbayPictureUrls([[FULL]]), [FULL]);
  assertEquals(normalizeEbayPictureUrls({ "#text": FULL }), [FULL]);
  assertEquals(normalizeEbayPictureUrls(null), []);
  assertEquals(normalizeEbayPictureUrls(undefined), []);
  assertEquals(normalizeEbayPictureUrls(42), []);
});

Deno.test("a non-eBay URL is dropped, not hot-linked", () => {
  const urls = normalizeEbayPictureUrls([
    FULL,
    "https://tracker.example.com/pixel.gif",
  ]);
  assertEquals(urls, [FULL]);
});

Deno.test("the picture count is bounded", () => {
  const many = Array.from(
    { length: 60 },
    (_, i) => `https://i.ebayimg.com/images/g/X${i}/s-l1600.jpg`,
  );
  assertEquals(normalizeEbayPictureUrls(many).length, MAX_MIRRORED_PHOTOS);
});

Deno.test("an empty item takes eBay's whole set, first picture as the front", () => {
  const b = "https://i.ebayimg.com/images/g/B/s-l1600.jpg";
  const rows = planPhotoMirror([FULL, b], []);
  assertEquals(rows.length, 2);
  assertEquals(rows[0]!.photo_type, "front");
  assertEquals(rows[1]!.photo_type, "detail");
  assertEquals(rows[0]!.storage_path, null);
  assertEquals(rows[0]!.remote_source, "ebay");
  assertEquals(rows[0]!.remote_source_url, FULL);
  assertEquals(rows.map((r) => r.sort_order), [0, 1]);
});

Deno.test("a second sync adds nothing it already added", () => {
  const b = "https://i.ebayimg.com/images/g/B/s-l1600.jpg";
  const existing = [
    { remote_source: "ebay", remote_source_url: FULL },
    { remote_source: "ebay", remote_source_url: b },
  ];
  assertEquals(planPhotoMirror([FULL, b], existing), []);
});

Deno.test("a picture the seller added to the listing later still arrives", () => {
  const b = "https://i.ebayimg.com/images/g/B/s-l1600.jpg";
  const rows = planPhotoMirror([FULL, b], [
    { remote_source: "ebay", remote_source_url: FULL },
  ]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.remote_source_url, b);
  // Numbered after what is already there, so it lands at the end rather than
  // fighting the existing photo for position 0.
  assertEquals(rows[0]!.sort_order, 1);
  assertEquals(rows[0]!.photo_type, "detail");
});

Deno.test("a sync never appends to a photo set the seller owns", () => {
  // The rule that matters most. An item with even one photo GradeThread holds
  // the file for is the seller's to curate; twelve eBay near-duplicates
  // appearing behind their back is not a sync.
  const owned = [{ remote_source: null, remote_source_url: null }];
  assertEquals(planPhotoMirror([FULL], owned), []);
});

Deno.test("adopting a photo stops the mirror rather than re-adding it", () => {
  // What an adopted row looks like: remote_source cleared (the bytes are ours),
  // remote_source_url kept (the dedupe key). Both halves are load-bearing —
  // clearing the URL too would make this sync add the picture all over again.
  const adopted = [{ remote_source: null, remote_source_url: FULL }];
  assertEquals(planPhotoMirror([FULL], adopted), []);
});

Deno.test("US-3196: a mirrored photo is never handed to a marketplace", () => {
  // The mirror's rows carry a live i.ebayimg.com URL in photo_url. Publishing
  // one would offer eBay's own render of a listing back as the picture for a
  // new one, and on Depop/Etsy/Shopify would leave the listing's imagery on a
  // competitor's CDN, to vanish when the seller ends the eBay listing.
  const mirrored = planPhotoMirror([FULL], [])[0]!;
  assertEquals(
    publicItemPhotoUrl({
      photo_url: mirrored.photo_url,
      storage_path: mirrored.storage_path,
      photo_type: mirrored.photo_type,
    }),
    null,
  );
  // And the adopted copy of that same photo IS publishable, which is the whole
  // point of the adopt action.
  assertEquals(
    publicItemPhotoUrl({
      photo_url: "https://cdn.example.com/item-photos/ebay_0_1.jpg",
      storage_path: "owner/item/ebay_0_1.jpg",
      photo_type: "front",
    }),
    "https://cdn.example.com/item-photos/ebay_0_1.jpg",
  );
});

Deno.test("a mirrored row names eBay's small render as its thumbnail", () => {
  // Every grid, list and cover reads thumbnail_url FIRST and only falls back to
  // photo_url. A null here meant each of them pulled the 1600px original, and
  // where the Cloudflare resizer is on, the fallback path asks
  // /cdn-cgi/image/.../<an ebay url>, which answers 403 for an origin
  // Cloudflare does not serve. That is why a synced photo showed in the
  // full-size preview and nowhere else.
  const row = planPhotoMirror([FULL], [])[0]!;
  assertEquals(row.photo_url, FULL);
  assertEquals(
    row.thumbnail_url,
    "https://i.ebayimg.com/images/g/AbCdEfGh/s-l500.jpg",
  );
});

Deno.test("a URL we cannot resize gets no thumbnail rather than a guess", () => {
  // photo_url is a working image either way, so degrading to "no thumbnail" is
  // the safe direction. Inventing a URL eBay may not serve is not.
  const legacy = "https://i.ebayimg.com/00/s/MTYwMFgxMjAw/z/abc/$_57.JPG";
  assertEquals(thumbnailEbayPictureUrl(legacy), null);
  assertEquals(planPhotoMirror([legacy], [])[0]!.thumbnail_url, null);
});
