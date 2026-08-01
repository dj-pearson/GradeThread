// US-1454: an end-listing automation withdraws the live eBay offer FIRST
// (US-467), then writes the local state (listing → ended, item → drafted). If a
// local write fails after the remote withdraw succeeded, the action must NOT be
// recorded as applied — otherwise a listing ended on eBay but still active
// locally is logged as a clean success, hiding the desync.
// endListingWritesApplied is the gate the handler checks before recording.

import "./_env.ts";
import { assert } from "@std/assert";
import { endListingWritesApplied } from "../routes/flipdesk-automations.ts";

Deno.test("both local writes clean → applied", () => {
  assert(endListingWritesApplied(null, null));
  assert(endListingWritesApplied(undefined, undefined));
});

Deno.test("withdraw-succeeds / local-write-fails → NOT applied (no action recorded)", () => {
  // listings → ended write failed.
  assert(!endListingWritesApplied({ message: "db down" }, null));
  // inventory_items → drafted write failed.
  assert(!endListingWritesApplied(null, { message: "db down" }));
  // both failed.
  assert(!endListingWritesApplied({ message: "a" }, { message: "b" }));
});
