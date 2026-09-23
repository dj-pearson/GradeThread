// US-3472: a category first cached through its NAME must not be served as a
// category with no item specifics.
//
// getCategoryName used to upsert `aspects: {}` with a fresh fetched_at when no
// row existed, and getCategoryAspects only checked the row's age. So a category
// first seen by sync, orphan adoption or the catalog route read as having zero
// aspects for the whole 7-day TTL. Measured 2026-09-23: 7 of 133 prod rows held
// `{}`, among them Socks and Hats.
//
// These pin the two halves of the fix: the row a name-only write produces is
// not a usable cache hit, and an empty payload is a miss even inside the TTL.
//   deno test -A src/tests/ebay-aspect-cache_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  aspectCacheRowIsUsable,
  nameOnlyAspectCacheRow,
} from "../lib/ebay-client.ts";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const PAYLOAD = { aspects: [{ localizedAspectName: "Size" }] };

Deno.test("a fresh row that holds eBay's aspects array is a cache hit", () => {
  assert(aspectCacheRowIsUsable({ aspects: PAYLOAD, fetched_at: at(DAY) }, NOW));
});

Deno.test("the row a name-only write produces is never a cache hit", () => {
  const row = nameOnlyAspectCacheRow("EBAY_US", "0", "11511", "Clothing > Socks");
  assertEquals(row.category_name, "Clothing > Socks");
  assertEquals(aspectCacheRowIsUsable(row, NOW), false);
});

Deno.test("an empty payload is a miss even when it was written a minute ago", () => {
  assertEquals(aspectCacheRowIsUsable({ aspects: {}, fetched_at: at(60_000) }, NOW), false);
  assertEquals(aspectCacheRowIsUsable({ aspects: null, fetched_at: at(60_000) }, NOW), false);
});

Deno.test("a full payload past the 7-day TTL is a miss", () => {
  assertEquals(aspectCacheRowIsUsable({ aspects: PAYLOAD, fetched_at: at(7 * DAY) }, NOW), false);
  assert(aspectCacheRowIsUsable({ aspects: PAYLOAD, fetched_at: at(7 * DAY - 1) }, NOW));
});

Deno.test("an unreadable fetched_at is a miss, not a hit", () => {
  assertEquals(aspectCacheRowIsUsable({ aspects: PAYLOAD, fetched_at: "not a date" }, NOW), false);
  assertEquals(aspectCacheRowIsUsable(null, NOW), false);
});

Deno.test("getCategoryName no longer writes the old empty-aspects upsert", async () => {
  const raw = await Deno.readTextFile(new URL("../lib/ebay-client.ts", import.meta.url));
  // Comments quote the old line on purpose; only code counts.
  const src = raw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assertEquals(src.includes("aspects: cached?.aspects ?? {}"), false);
  assert(src.includes("aspectCacheRowIsUsable(cached, Date.now())"));
});
