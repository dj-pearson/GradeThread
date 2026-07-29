// Listing-image URL validation shared by the extension's two grading surfaces
// (US-1755 / US-2238 / US-2241).
//
// Imports lib/extension-image-urls.ts directly and asserts with node:assert, so
// the whole file resolves with NO network — the parser is the last thing that
// runs before a URL reaches a fetcher or an AI action is reserved, and it should
// be checkable anywhere, not only in CI.

import assert from "node:assert/strict";

import {
  clampImageCap,
  EXTENSION_MAX_IMAGES_ANON,
  EXTENSION_MAX_IMAGES_PAID,
  parseListingImageUrls,
} from "../lib/extension-image-urls.ts";
import { resolveExtensionGates } from "../lib/extension-gates.ts";

const MSG = {
  malformed: "Each image must be a valid URL.",
  scheme: "Image URLs must be http(s).",
  empty: "Provide at least one image URL.",
};

function urls(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://i.ebayimg.com/${i}.jpg`);
}

Deno.test("accepts an array and a bare string", () => {
  const many = parseListingImageUrls(urls(3), 4, MSG);
  assert(many.ok);
  assert.equal(many.urls.length, 3);

  const one = parseListingImageUrls("https://i.ebayimg.com/1.jpg", 4, MSG);
  assert(one.ok);
  assert.deepEqual(one.urls, ["https://i.ebayimg.com/1.jpg"]);
});

Deno.test("rejects non-http(s) schemes before anything opens a socket", () => {
  // file:// and data: would be read locally; javascript: is junk that should
  // never reach a fetcher at all.
  for (const bad of [
    "file:///etc/passwd",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "ftp://example.com/a.jpg",
  ]) {
    const r = parseListingImageUrls([bad], 4, MSG);
    assert.equal(r.ok, false, `${bad} must be rejected`);
    if (!r.ok) assert.equal(r.error, MSG.scheme);
  }
});

Deno.test("a malformed URL is a hard error, not a silent skip", () => {
  // A caller sending "not a url" meant something; dropping it quietly would hide
  // a broken integration behind a partially-graded result.
  const r = parseListingImageUrls(["not a url"], 4, MSG);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, MSG.malformed);
});

Deno.test("non-string entries are skipped, valid ones survive", () => {
  // The opposite call from the one above, and deliberately so: a null in a
  // scraped gallery array is noise, not intent.
  const r = parseListingImageUrls([null, "https://a.test/1.jpg", 7, "https://a.test/2.jpg"], 4, MSG);
  assert(r.ok);
  assert.deepEqual(r.urls, ["https://a.test/1.jpg", "https://a.test/2.jpg"]);
});

Deno.test("empty / junk input is an error, never an empty pass", () => {
  for (const input of [[], null, undefined, 42, {}, [""], ["   "], [123, null]]) {
    const r = parseListingImageUrls(input, 4, MSG);
    assert.equal(r.ok, false, `${JSON.stringify(input)} must fail`);
  }
});

Deno.test("a private-range host still parses here — safeFetch is the SSRF gate", () => {
  // Deliberate: this is SHAPE validation. The blocklist lives in safeFetch, which
  // also re-validates every redirect hop — something a pure function could not do
  // correctly, since a public hostname can resolve to a private address.
  const r = parseListingImageUrls(["http://169.254.169.254/latest/meta-data/"], 4, MSG);
  assert(r.ok, "shape validation passes it; safeFetch is what blocks it");
});

// ── US-2241: the cap is the caller's tier, clamped ─────────────────────────
Deno.test("anonymous gets exactly the floor", () => {
  const gates = resolveExtensionGates(null);
  assert.equal(gates.maxImages, EXTENSION_MAX_IMAGES_ANON);
  const r = parseListingImageUrls(urls(20), gates.maxImages, MSG);
  assert(r.ok);
  assert.equal(r.urls.length, 4);
});

Deno.test("a paid tier gets the deeper read", () => {
  const gates = resolveExtensionGates({ plan: "guard", gateFlags: {} });
  assert.equal(gates.maxImages, EXTENSION_MAX_IMAGES_PAID);
  const r = parseListingImageUrls(urls(20), gates.maxImages, MSG);
  assert(r.ok);
  assert.equal(r.urls.length, 8);
});

Deno.test("an authenticated FREE plan stays at the anonymous cap", () => {
  // Signing in is not the same as paying. The deeper read is what the plan buys.
  assert.equal(resolveExtensionGates({ plan: "free", gateFlags: {} }).maxImages, 4);
});

Deno.test("an unknown FUTURE plan inherits the paid cap, not the floor", () => {
  // `plan` is a free-form string from the entitlements row. Enumerating plan
  // names would mean a plan added later silently falls back to the free read.
  assert.equal(resolveExtensionGates({ plan: "collector-2027", gateFlags: {} }).maxImages, 8);
});

Deno.test("the cap is clamped in BOTH directions", () => {
  // Too high turns one request into unbounded Vision calls; zero or NaN starves
  // a paying caller down to nothing.
  for (const bogus of [9999, Infinity, -Infinity, NaN, 0, -5, undefined, null, "eight", {}]) {
    const capped = clampImageCap(bogus);
    assert(
      capped >= EXTENSION_MAX_IMAGES_ANON && capped <= EXTENSION_MAX_IMAGES_PAID,
      `clampImageCap(${JSON.stringify(bogus)}) = ${capped}, outside the allowed band`,
    );
    const r = parseListingImageUrls(urls(50), bogus as number, MSG);
    assert(r.ok);
    assert(r.urls.length >= EXTENSION_MAX_IMAGES_ANON && r.urls.length <= EXTENSION_MAX_IMAGES_PAID);
  }
});

Deno.test("a listing with fewer photos than the cap is unaffected", () => {
  const r = parseListingImageUrls(urls(2), EXTENSION_MAX_IMAGES_PAID, MSG);
  assert(r.ok);
  assert.equal(r.urls.length, 2);
});
