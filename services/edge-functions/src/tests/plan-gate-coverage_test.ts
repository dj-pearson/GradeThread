// US-2179: plan-gate COVERAGE drift test.
//
// plan-gate_test.ts proves the gate DECIDES correctly. Nothing proved the gate is
// actually CALLED — and enforcement lives in each handler, so a route that
// forgets simply has no limits. That is exactly how the activeListings cap ended
// up enforced on the eBay publish paths only, while /cross-push (depop, etsy,
// shopify, whatnot) and /extension-writeback (poshmark, mercari, grailed) put
// items live without ever consulting it.
//
// This walks src/routes/ statically and asserts three invariants, in the same
// pattern as ai-metering-coverage_test.ts / rls-guard / cron-registry:
//
//   1. a route that puts an item LIVE gates the activeListings capacity
//   2. a route that CONNECTS a marketplace gates the marketplaces capacity
//   3. a route that ENDS a listing reconciles the item status, so the cap slot
//      is released instead of leaking (the failure mode is silent: the seller is
//      billed-by-cap for listings that no longer exist)
//
// Every allow-list entry needs a rationale a reviewer can veto.
//
//   deno test --allow-read src/tests/plan-gate-coverage_test.ts

import { assert, assertEquals } from "@std/assert";

// One file at a time, the eBay route files included. They were first judged as
// one pooled unit after flipdesk-ebay.ts was split into flipdesk-ebay-*.ts,
// which let the publish file's gate stand in for the sync file's status flips
// and the listings file's release stand in for the post-sale file's listing
// end. Each of those now answers for itself, with a named exemption below
// where the answer is "by design".
async function routeFiles(): Promise<Array<{ name: string; text: string }>> {
  const dir = new URL("../routes/", import.meta.url);
  const out: Array<{ name: string; text: string }> = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".ts")) {
      out.push({
        name: e.name,
        text: await Deno.readTextFile(new URL(e.name, dir)),
      });
    }
  }
  return out;
}

/** Does `text` contain a supabase call chain on `table` using one of `ops`? */
function writesTable(text: string, table: string, ops: string[]): boolean {
  const marker = `from("${table}")`;
  let from = text.indexOf(marker);
  while (from !== -1) {
    // The chained op follows within a few lines of the .from(...).
    const window = text.slice(from, from + 600);
    if (ops.some((op) => window.includes(`.${op}(`))) return true;
    from = text.indexOf(marker, from + marker.length);
  }
  return false;
}

// ── 1. Putting an item live consumes an activeListings slot ──────────

// A route puts an item live if it flips the item to 'listed' itself or delegates
// to the shared helper.
const GOES_LIVE = /status: "listed"|markItemListed\(/;
const ACTIVE_LISTINGS_GATE = /kind: "activeListings"/;

const GOES_LIVE_ALLOWLIST: Record<string, string> = {
  // The crosslist action calls markItemListed, so it trips the GOES_LIVE
  // pattern — but it cannot consume a slot. loadOwnerListings selects
  // .eq("platform","ebay").eq("listing_status","active"), so every listing a
  // rule can act on is ALREADY live and already occupies its slot, and the cap
  // counts live ITEMS rather than listing rows, so fanning one out to a second
  // channel adds nothing to the count. The markItemListed call exists to close
  // the one desync case (eBay active, item status drifted off 'listed'), which
  // is accounting repair, not a new publish. Gating it would refuse to FIX the
  // count for a seller sitting at their cap. See flipdesk-automations.ts:919.
  "flipdesk-automations.ts":
    "crosslist only runs against already-active eBay listings, so the item's " +
    "slot is already consumed; markItemListed here repairs the count rather " +
    "than adding to it",
  // Every status: "listed" write in the sync file records a listing eBay says
  // is ALREADY live: the two batched flips after the active-listing passes
  // (items whose offer or ActiveList entry is active on eBay right now) and the
  // cancel arm of order reconciliation, which restores 'listed' and then calls
  // resyncItemListedStatus so it drops straight to 'drafted' unless something
  // really is live. None of them publishes anything, so there is no request to
  // refuse: the listing exists whatever this code does, and leaving the item
  // off 'listed' would only make the cap count lie low, which is the failure
  // US-2179 fixed. A listing the seller made in Seller Hub counts against the
  // cap here and blocks their NEXT FlipDesk publish, which is the cap working.
  // The one path in this file that CREATES items, orphan adoption, is gated:
  // it is capped by capacityHeadroom(userId, "activeListings"), and
  // ebay-orphan-adopt_test.ts pins that.
  "flipdesk-ebay-sync.ts":
    "sync only records listings already live on eBay (status flips and the " +
    "cancel restore); the item-creating orphan adoption is capped by " +
    "capacityHeadroom, pinned in ebay-orphan-adopt_test.ts",
};

Deno.test("drift: every route that puts an item live gates the activeListings cap", async () => {
  const offenders: string[] = [];
  for (const f of await routeFiles()) {
    if (!GOES_LIVE.test(f.text)) continue;
    if (f.name in GOES_LIVE_ALLOWLIST) continue;
    if (!ACTIVE_LISTINGS_GATE.test(f.text)) offenders.push(f.name);
  }
  assertEquals(
    offenders,
    [],
    `Route(s) put an inventory item live without gating the activeListings cap: ${
      offenders.join(", ")
    }. Call requireFlipdesk(c, { capacity: { kind: "activeListings", delta: ` +
      `alreadyListed ? 0 : 1 }, userId }) before publishing, or allow-list WITH a rationale.`,
  );
});

// ── 2. Connecting a marketplace consumes a marketplaces slot ─────────

const MARKETPLACES_GATE = /kind: "marketplaces"/;

// Routes that CREATE a marketplace connection but are not a seller-initiated
// connect. Empty today: every route that only ever .update()s an existing
// connection (admin reconnect requests, revocation webhooks, billing reconciles)
// fails the insert/upsert marker and never reaches the allow-list. An entry here
// needs a reason a reviewer can veto.
const CONNECT_ALLOWLIST: Record<string, string> = {};

Deno.test("drift: every route that creates a marketplace connection gates the marketplaces cap", async () => {
  const offenders: string[] = [];
  for (const f of await routeFiles()) {
    if (!writesTable(f.text, "marketplace_connections", ["insert", "upsert"])) {
      continue;
    }
    if (f.name in CONNECT_ALLOWLIST) continue;
    if (!MARKETPLACES_GATE.test(f.text)) offenders.push(f.name);
  }
  assertEquals(
    offenders,
    [],
    `Route(s) create a marketplace connection without gating the marketplaces cap: ${
      offenders.join(", ")
    }. Call requireFlipdesk(c, { capacity: { kind: "marketplaces", delta: ` +
      `alreadyConnected ? 0 : 1 } }), or allow-list WITH a rationale.`,
  );
});

// ── 3. Ending a listing must release the item's cap slot ─────────────
//
// The mirror of invariant 1, and the quieter bug: a route that marks a listing
// ended without reconciling the item leaves it 'listed' forever, so the seller
// keeps paying a cap slot for a listing that no longer exists. Nothing fails
// loudly — the cap just silently shrinks over time.

const ENDS_LISTING = /listing_status: "ended"/;
const RELEASES_SLOT = /resyncItemListedStatus\(/;

// PS-03 emptied this. The one route that ended a listing without a resync,
// flipdesk-ebay-post-sale.ts, now does it through lib/post-sale-outcome.ts,
// and the test below holds that function to the same rule the allow-list
// entry used to state: the item leaves 'listed' in the same plan that ends
// the listing.
const ENDS_LISTING_ALLOWLIST: Record<string, string> = {};

Deno.test("post-sale: the listing end sits beside the item's 'returned' write", async () => {
  const text = await Deno.readTextFile(
    new URL("../lib/post-sale-outcome.ts", import.meta.url),
  );
  const fn = text.indexOf("async function applyOutcomeToSale(");
  assert(fn !== -1, "applyOutcomeToSale moved; re-check the post-sale exemption");
  const body = text.slice(fn, text.indexOf("\n}\n", fn));
  const itemWrite = body.indexOf('.update({ status: "returned" })');
  const listingEnd = body.indexOf('listing_status: "ended"');
  assert(listingEnd !== -1, "applyOutcomeToSale no longer ends the listing");
  assert(
    itemWrite !== -1 && itemWrite < listingEnd,
    "applyOutcomeToSale must move the item to 'returned' before ending its " +
      "listing, or its cap slot is no longer released and the exemption is wrong",
  );
  // No other listing end in the file: the exemption covers this one only.
  assertEquals(text.split('listing_status: "ended"').length - 1, 1);
  // And the route that calls it no longer ends a listing by itself.
  const route = await Deno.readTextFile(
    new URL("../routes/flipdesk-ebay-post-sale.ts", import.meta.url),
  );
  assert(!ENDS_LISTING.test(route), "flipdesk-ebay-post-sale.ts ends a listing directly again");
});

Deno.test("post-sale: no outcome ends a listing without restoring its item", async () => {
  const { outcomeWritePlan } = await import("../lib/ebay-postorder.ts");
  for (
    const o of [
      "return_refunded",
      "inr_refunded",
      "dispute_accepted",
      "return_declined",
      "cancel_approved",
      "cancel_rejected",
    ] as const
  ) {
    const plan = outcomeWritePlan(o);
    assert(!plan.endListing || plan.restoreItem, `${o} ends a listing but keeps the item 'listed'`);
  }
});

Deno.test("drift: every route that ends a listing releases the item's cap slot", async () => {
  const offenders: string[] = [];
  for (const f of await routeFiles()) {
    if (!ENDS_LISTING.test(f.text)) continue;
    if (f.name in ENDS_LISTING_ALLOWLIST) continue;
    if (!RELEASES_SLOT.test(f.text)) offenders.push(f.name);
  }
  assertEquals(
    offenders,
    [],
    `Route(s) end a listing without reconciling the item's status: ${
      offenders.join(", ")
    }. Call resyncItemListedStatus(inventoryItemId, ownerId) (lib/active-listings.ts) ` +
      `after the listing write — it only frees the slot when NOTHING is live — or ` +
      `allow-list WITH a rationale.`,
  );
});

// ── 4. The allow-lists must not rot ─────────────────────────────────

Deno.test("drift: gating allow-lists carry no stale entries", async () => {
  const files = await routeFiles();
  const stale: string[] = [];

  for (const name of Object.keys(GOES_LIVE_ALLOWLIST)) {
    const f = files.find((x) => x.name === name);
    if (!f || !GOES_LIVE.test(f.text)) stale.push(`${name} (goes-live)`);
  }
  for (const name of Object.keys(CONNECT_ALLOWLIST)) {
    const f = files.find((x) => x.name === name);
    if (
      !f || !writesTable(f.text, "marketplace_connections", ["insert", "upsert"])
    ) {
      stale.push(`${name} (connect)`);
    }
  }
  for (const name of Object.keys(ENDS_LISTING_ALLOWLIST)) {
    const f = files.find((x) => x.name === name);
    if (!f || !ENDS_LISTING.test(f.text)) stale.push(`${name} (ends-listing)`);
  }

  assertEquals(
    stale,
    [],
    `Allow-listed route(s) no longer match the marker they were excused from — remove: ${
      stale.join(", ")
    }`,
  );
});

// ── 5. The counting basis is load-bearing ───────────────────────────

Deno.test("the activeListings cap counts items in status 'listed'", async () => {
  const text = await Deno.readTextFile(
    new URL("../lib/plan-gate.ts", import.meta.url),
  );
  // Anchor on the readCurrentUsage branch (the block form) — getLimit has a
  // one-line `case "activeListings":` earlier in the file that matches too.
  const idx = text.indexOf('case "activeListings": {');
  assertEquals(
    idx !== -1,
    true,
    "plan-gate no longer has an activeListings usage branch",
  );
  const branch = text.slice(idx, idx + 500);
  // If this ever changes to count `listings` rows instead, every existing cap is
  // silently re-scaled: one cross-listed item owns one row PER platform, so an
  // item live on eBay + Depop + Poshmark would start consuming 3 of 25 Free
  // slots. The caps were sized for "one live item = one slot".
  assertEquals(
    branch.includes('from("inventory_items")') &&
      branch.includes('"status", "listed"'),
    true,
    "The activeListings cap must count inventory_items in status 'listed'. " +
      "Counting listings rows instead re-scales every plan cap — see " +
      "lib/active-listings.ts for why the item status is the basis.",
  );
});
