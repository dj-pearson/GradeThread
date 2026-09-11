// US-3213: one button publishes to the APIs and queues the extension channels.
//
// Both assertions here are source scans, on purpose. crossPushPlatform needs a
// database and the route needs a request, so the things most likely to break
// silently are not reachable from a unit test — but they ARE reachable by
// reading the source, and both failures are invisible at runtime:
//
//   • If the extension set drifts, a channel quietly falls through to its stub
//     adapter, returns 501, and the seller sees "publishing there ships soon"
//     for a marketplace the queue can already handle. That is the exact bug
//     this story fixed, restored by omission.
//   • If the `!r.queued` gate is dropped, an item is marked listed on the
//     strength of a job that has not run. It consumes an activeListings cap
//     slot and tells the seller it is up. If the desktop never drains, the lie
//     is permanent, and nothing goes red.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { EXTENSION_DELIST_PLATFORMS } from "../lib/cross-listing-sale.ts";

const read = (rel: string) =>
  Deno.readTextFileSync(new URL(`../${rel}`, import.meta.url));

Deno.test("US-3213: cross-push routes every extension channel to the queue", () => {
  const src = read("lib/cross-push.ts");
  // Derived from the delist set rather than restated, so a channel we can list
  // to is always one we can also end — the drift that causes an oversell.
  assert(
    src.includes("EXTENSION_DELIST_PLATFORMS.has(platform)"),
    "cross-push must decide the queue branch from EXTENSION_DELIST_PLATFORMS. " +
      "A second hand-written list is how a channel ends up listable but not " +
      "delistable, which is the oversell US-2165 is about.",
  );
  assert(
    src.includes("enqueueExtensionWork"),
    "cross-push must enqueue extension work rather than calling a stub adapter",
  );
});

Deno.test("US-3213: the web's extension channels are all covered", () => {
  // The composer offers these five in its Push to card. Each one must reach the
  // queue branch, or selecting it does nothing a seller can see.
  for (
    const platform of ["poshmark", "mercari", "grailed", "vinted", "facebook"]
  ) {
    assert(
      EXTENSION_DELIST_PLATFORMS.has(platform),
      `${platform} is offered as an extension cross-post channel on the web ` +
        `but is not in EXTENSION_DELIST_PLATFORMS, so cross-push would send ` +
        `it to a stub adapter and answer 501.`,
    );
  }
});

Deno.test("US-3213: a queued channel does not advance the item to listed", () => {
  const src = read("routes/flipdesk-listings.ts");
  assert(
    src.includes("r?.ok && !r.queued"),
    "the advance-to-listed gate must exclude queued results. An enqueue is " +
      "not a publish: marking the item listed spends an activeListings slot " +
      "and tells the seller it is up, on a job that has not run.",
  );
  // And the flag has to survive the trip, or the gate above is reading
  // undefined on every row and is therefore always true.
  // US-3367 added `skipped` as the fifth argument; `queued` still rides fourth.
  assertEquals(
    src.includes("toPushResult(result, listingRowId, price, queued, skipped)"),
    true,
    "the route must pass `queued` through to the response",
  );
});
