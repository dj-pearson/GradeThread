// US-3185: one scanned code, a bin of garments.
//
// The rule that carries the whole feature is that the PHONE NEVER NAMES A
// GROUP. It can ask to advance and nothing else, so the only grouping a
// tampered page can produce is one the seller could have produced by tapping
// the button. Every case here is either that rule or one of its two refusals.

import { assert, assertEquals } from "@std/assert";
import {
  CAPTURE_MAX_GROUPS,
  CAPTURE_MAX_PHOTOS,
  CAPTURE_TARGET_KINDS,
  type CaptureSessionState,
  isCaptureTargetKind,
  isMultiItemCapture,
  nextGroupIndex,
  publicView,
} from "../lib/phone-capture.ts";

function live(over: Partial<CaptureSessionState> = {}): CaptureSessionState {
  return {
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ended_at: null,
    photo_count: 0,
    bytes_total: 0,
    group_index: 0,
    ...over,
  };
}

Deno.test("staging is a target kind, because AutoLister has no batch row yet", () => {
  assert(isCaptureTargetKind("staging"));
  assertEquals([...CAPTURE_TARGET_KINDS], ["item", "batch", "staging"]);
});

Deno.test("an item code walks no bin; a batch and a staging code both do", () => {
  assertEquals(isMultiItemCapture("item"), false);
  assertEquals(isMultiItemCapture("batch"), true);
  assertEquals(isMultiItemCapture("staging"), true);
});

Deno.test("the boundary moves one item at a time, never further", () => {
  assertEquals(nextGroupIndex(0, 1), 1);
  assertEquals(nextGroupIndex(1, 3), 2);
  assertEquals(nextGroupIndex(7, 1), 8);
});

Deno.test("an item with no photos on it does not advance, so no empty item is made", () => {
  // The seller taps Next item twice, or taps it before the first shot. Both
  // would otherwise leave a group the desktop has to show and they have to
  // delete.
  assertEquals(nextGroupIndex(0, 0), 0);
  assertEquals(nextGroupIndex(4, 0), 4);
});

Deno.test("the last item does not advance past the ceiling", () => {
  assertEquals(nextGroupIndex(CAPTURE_MAX_GROUPS - 1, 5), CAPTURE_MAX_GROUPS - 1);
  assertEquals(nextGroupIndex(CAPTURE_MAX_GROUPS + 99, 5), CAPTURE_MAX_GROUPS + 99);
});

Deno.test("the ceiling cannot outrun the photo cap, because an item needs a photo", () => {
  // An empty group never advances, so reaching group N costs at least N
  // photos. A ceiling above the photo cap would therefore be unreachable and
  // would read as a limit that does something.
  assertEquals(CAPTURE_MAX_GROUPS, CAPTURE_MAX_PHOTOS);
});

Deno.test("a nonsense stored index reads as the first item rather than crashing", () => {
  assertEquals(nextGroupIndex(-1, 3), 0);
  assertEquals(nextGroupIndex(Number.NaN, 3), 0);
  assertEquals(nextGroupIndex(1.5, 3), 0);
});

Deno.test("a bin code reports which item the phone is on", () => {
  const view = publicView({ ...live({ group_index: 2, photo_count: 5 }), target_kind: "staging" }, [], 2);
  assertEquals(view.groupIndex, 2);
  assertEquals(view.photosInGroup, 2);
  assertEquals(view.multiItem, true);
});

Deno.test("an item code reports no boundary at all, whatever the row says", () => {
  // Defensive rather than hypothetical: the column defaults to 0 for every
  // row, so a non-zero index on an item session could only come from a bug,
  // and surfacing it would put a "Next item" control on a code that has one.
  const view = publicView({ ...live({ group_index: 3, photo_count: 4 }), target_kind: "item" }, [], 1);
  assertEquals(view.groupIndex, 0);
  assertEquals(view.multiItem, false);
  // photosInGroup for a one-item code is simply its photo count: there is no
  // other item for a shot to be on.
  assertEquals(view.photosInGroup, 4);
});

Deno.test("an unknown target kind still reads as one item rather than a bin", () => {
  const view = publicView({ ...live({ group_index: 2 }), target_kind: "wat" }, [], 0);
  assertEquals(view.targetKind, "item");
  assertEquals(view.multiItem, false);
  assertEquals(view.groupIndex, 0);
});

// ── The wiring a pure test cannot see ───────────────────────────────
//
// Source scans, and each one pins the property that would be silently wrong
// rather than the expression that happens to implement it today.

const ROUTE = await Deno.readTextFile(
  new URL("../routes/flipdesk-phone-capture.ts", import.meta.url),
);

Deno.test("a photo's group comes from the session, never from the request", async () => {
  // The whole trust model. If the insert read a group index off the multipart
  // body, a page could scatter one seller's bin across forty items, and every
  // pure test above would still pass.
  const body = ROUTE.slice(ROUTE.indexOf('post("/s/:token/photos"'));
  assert(
    /group_index:\s*group\b/.test(body),
    "the photo insert no longer stamps the session's group index",
  );
  assert(
    !/form\[["']groupIndex["']\]/.test(ROUTE),
    "the upload route started reading a group index out of the request body",
  );
  await Promise.resolve();
});

Deno.test("the desktop's photo read carries the group and orders by it", () => {
  assert(
    /\.select\([^)]*group_index[^)]*\)/.test(ROUTE),
    "the session photo read stopped selecting group_index",
  );
  assert(
    /\.order\(\s*["']group_index["']/.test(ROUTE),
    "the session photo read stopped ordering by group_index, so the desktop " +
      "would stage a bin in arrival order rather than in item order",
  );
});

Deno.test("next-item refuses a code bound to a single item", () => {
  const body = ROUTE.slice(ROUTE.indexOf('post("/s/:token/next-item"'));
  assert(body.length > 0, "the next-item route is gone");
  assert(
    /isMultiItemCapture\(kind\)/.test(body),
    "next-item stopped checking whether this code walks a bin",
  );
  assert(
    /refuseCapture\(session, 0\)/.test(body),
    "next-item stopped applying the expiry and ended-code refusals",
  );
});

Deno.test("a staging target is accepted without a row, and only in that one shape", () => {
  const owns = ROUTE.slice(ROUTE.indexOf("async function ownsTarget"));
  assert(
    /kind === "staging"/.test(owns),
    "ownsTarget no longer knows about the staging kind",
  );
  assert(
    /UUID_RE\.test\(id\)/.test(owns),
    "a staging target id is no longer required to look like a session id",
  );
  // The other two kinds must still be checked against a row the caller owns.
  assert(
    /\.eq\("user_id", ownerId\)/.test(owns),
    "the owner filter came off the item and batch ownership check",
  );
});
