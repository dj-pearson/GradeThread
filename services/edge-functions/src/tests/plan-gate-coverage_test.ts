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

import { assertEquals } from "@std/assert";

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

const ENDS_LISTING_ALLOWLIST: Record<string, string> = {};

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
