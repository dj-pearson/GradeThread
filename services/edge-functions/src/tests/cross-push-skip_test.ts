// US-3367: cross-push must not queue an extension channel that is already
// live or already waiting. Re-queueing a live channel opens the create form
// again in the seller's browser and mints a DUPLICATE listing; re-queueing one
// with a job waiting fills the same form twice. The rule is pure so it is
// asserted here rather than reasoned about at the call site.

import "./_env.ts";
import { assertEquals } from "@std/assert";
import { planCrossPushSkip } from "../lib/cross-push.ts";

const LIVE_URL = "https://poshmark.com/listing/x";

Deno.test("a live sibling with a URL is skipped as already_live", () => {
  assertEquals(
    planCrossPushSkip({ listing_status: "active", listing_url: LIVE_URL }, false),
    "already_live",
  );
});

Deno.test("a pending list job is skipped as already_queued", () => {
  assertEquals(
    planCrossPushSkip({ listing_status: "draft", listing_url: null }, true),
    "already_queued",
  );
});

Deno.test("a draft without a URL is NOT skipped", () => {
  assertEquals(planCrossPushSkip({ listing_status: "draft", listing_url: null }, false), null);
});

Deno.test("an active row with no URL is NOT skipped: nothing verified it went live", () => {
  assertEquals(planCrossPushSkip({ listing_status: "active", listing_url: null }, false), null);
});

Deno.test("an ended row is NOT skipped: a relist is allowed", () => {
  assertEquals(
    planCrossPushSkip({ listing_status: "ended", listing_url: LIVE_URL }, false),
    null,
  );
});

Deno.test("no row at all is not skipped", () => {
  assertEquals(planCrossPushSkip(null, false), null);
});

Deno.test("already_live wins over already_queued", () => {
  assertEquals(
    planCrossPushSkip({ listing_status: "active", listing_url: LIVE_URL }, true),
    "already_live",
  );
});

Deno.test("a row recorded as listed but unconfirmed is skipped as already_live (opt-out posture)", () => {
  assertEquals(
    planCrossPushSkip(
      { listing_status: "active", listing_url: null, listed_unconfirmed: true },
      false,
    ),
    "already_live",
  );
});

Deno.test("the unconfirmed marker on a non-active row changes nothing", () => {
  assertEquals(
    planCrossPushSkip(
      { listing_status: "draft", listing_url: null, listed_unconfirmed: true },
      false,
    ),
    null,
  );
});
