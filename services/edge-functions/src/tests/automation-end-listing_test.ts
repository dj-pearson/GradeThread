// US-1454: an end-listing automation withdraws the live eBay offer FIRST
// (US-467), then writes the local state (listing → ended, item → drafted). If a
// local write fails after the remote withdraw succeeded, the action must NOT be
// recorded as applied — otherwise a listing ended on eBay but still active
// locally is logged as a clean success, hiding the desync.
// endListingWritesApplied is the gate the handler checks before recording.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  classifyWithdrawFailure,
  endListingWritesApplied,
} from "../routes/flipdesk-automations.ts";

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

// US-2388: the automation's end/relist used to `return false` on ANY throw from
// withdrawOffer, so the local end write never ran. A listing eBay had already
// ended — the seller ended it there, eBay pulled it for a policy issue, or a
// prior tick already withdrew it — stayed "active" in FlipDesk forever, on a
// schedule, with no path by which a later run could ever recover it.
//
// Every other end/relist path already classified the throw
// (flipdesk-listings.ts, lib/cross-listings.ts, the manual eBay end route). The
// vault note asserted "every End/Relist path calls it rather than re-deriving
// the split" — this route was written afterwards and never adopted it, and the
// note's claim of universality is what let that pass review.
//
// The two directions are NOT symmetric, which is the whole reason to test both:
// failing to reconcile leaves a stuck row a later tick could in principle fix,
// while reconciling a STILL-LIVE listing is an oversell (US-1506) and is not
// recoverable at all. So "retry" has to be the default for anything unclear.

Deno.test("US-2388: an already-ended offer reconciles instead of aborting", () => {
  // eBay's own shape: a 4xx on withdrawing a known offer id.
  assertEquals(classifyWithdrawFailure({ status: 404 }), "already_ended");
  assertEquals(classifyWithdrawFailure({ status: 400 }), "already_ended");
  // Non-HTTP throw, classified by message.
  assertEquals(
    classifyWithdrawFailure(new Error("Offer not published")),
    "already_ended",
  );
  assertEquals(
    classifyWithdrawFailure(new Error("The offer does not exist")),
    "already_ended",
  );
});

Deno.test("US-2388: a transient failure still aborts so the rule retries", () => {
  // Rate limit and eBay 5xx — the live state is unknown, so the row must stay
  // active. Marking it ended here would be a local lie about a live listing.
  assertEquals(classifyWithdrawFailure({ status: 429 }), "retry");
  assertEquals(classifyWithdrawFailure({ status: 500 }), "retry");
  assertEquals(classifyWithdrawFailure({ status: 503 }), "retry");
});

Deno.test("US-2388: a disconnected account never reconciles (oversell guard)", () => {
  // US-1506: getUserAccessToken throws this BEFORE any withdraw is attempted,
  // so the eBay listing is still live. This is the case that must never be
  // read as already-ended, and it is preempted rather than left to the message
  // regex in isOfferAlreadyEndedError.
  const err = new Error("No active eBay connection for this user.");
  assertEquals(classifyWithdrawFailure(err), "retry");
});

Deno.test("US-2388: an unrecognisable failure defaults to retry", () => {
  // The safe direction. An error shape nobody anticipated must not end a
  // listing that might still be live.
  assertEquals(classifyWithdrawFailure(null), "retry");
  assertEquals(classifyWithdrawFailure(undefined), "retry");
  assertEquals(classifyWithdrawFailure(new Error("socket hang up")), "retry");
  assertEquals(classifyWithdrawFailure({ status: 0 }), "retry");
});
