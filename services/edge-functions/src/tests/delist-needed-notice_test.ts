// US-3144 — telling the seller their sold item is still listed somewhere.
//
// Until this story the `queued` outcome of an auto-end pass said NOTHING. The
// sibling was stamped, the desktop queue was filled, and a seller whose browser
// stayed shut learned nothing at all until the queue row expired a week later.
// Only the `unresolved` case ever spoke.
//
// Every property below has a silent failure behind it, which is why they are
// pinned rather than left to review:
//
//   - one notice per SALE, not per marketplace. Four channels, four buzzes, one
//     garment is how a seller turns the category off.
//   - the notice fires AFTER the loop, so its count is the real one.
//   - `delist_needed` gates on its own preference key. Under selling_activity it
//     would arrive for anyone who had agreed to a sentence about news.
//   - the native push carries `inventory_item_id`, which is the ONE key both
//     clients already parse to route a tap. Anything else needs new code on two
//     platforms to reach the same screen.
//   - the item filter on the read is applied ON TOP of the owner scope.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { PREF_KEY } = await import("../lib/notify.ts");

const CROSS = await Deno.readTextFile(new URL("../lib/cross-listings.ts", import.meta.url));
const PUSH = await Deno.readTextFile(new URL("../lib/transactional-push.ts", import.meta.url));
const PENDING = await Deno.readTextFile(new URL("../lib/pending-delists.ts", import.meta.url));
const ROUTE = await Deno.readTextFile(
  new URL("../routes/flipdesk-listings.ts", import.meta.url),
);

Deno.test("US-3144: delist_needed gates on its own preference category", () => {
  // Not selling_activity. That category's settings copy promises news about
  // listings going live and items selling; this one asks the seller to go and
  // end something. Routing a task under a sentence somebody agreed to for news
  // makes the sentence false — the same test reward_nudge and
  // integrity_tier_change failed, and they got their own categories too.
  assertEquals(PREF_KEY.delist_needed, "delist_reminders");
  assert(
    PREF_KEY.delist_needed !== PREF_KEY.sale_recorded,
    "delist_needed now shares a gate with sale_recorded, so a seller cannot " +
      "keep sale notifications while turning this one off",
  );
  // Never unmutable. `null` means always-delivered, and this one fires on the
  // seller's own success — it is the one they are most entitled to switch off.
  assert(PREF_KEY.delist_needed !== null, "delist_needed became unmutable");
});

Deno.test("US-3144: one notice per sale, sent after the loop", () => {
  const collect = CROSS.indexOf("queuedRows.push(row)");
  const send = CROSS.indexOf("await notifyDelistNeeded(ownerId, queuedRows)");
  const loopEnd = CROSS.indexOf("if (unresolvedPlatforms.size > 0)");
  assert(collect > -1, "the queued rows are no longer collected");
  assert(send > -1, "the delist-needed notice is no longer sent");
  assert(
    collect < loopEnd && send > loopEnd,
    "the notice moved inside the per-sibling loop. Four cross-listed channels " +
      "would then mean four notifications about one garment.",
  );

  // Guarded on there being something to say.
  assert(
    /if \(queuedRows\.length > 0\) \{/.test(CROSS),
    "the notice is sent unconditionally, so a sale with nothing queued still " +
      "tells the seller to go end listings that do not exist",
  );
});

Deno.test("US-3144: the notice reaches the phone, not only the dashboard", () => {
  const fn = CROSS.slice(
    CROSS.indexOf("async function notifyDelistNeeded("),
    CROSS.indexOf("async function queueExtensionDelist("),
  );
  assert(fn.length > 400, "notifyDelistNeeded moved");
  assert(
    /type: "delist_needed"/.test(fn),
    "the in-app + web-push notice lost its type",
  );
  assert(
    /void pushDelistNeeded\(ownerId, \{/.test(fn),
    "the native push is gone. notifyUser reaches the in-app row and the BROWSER " +
      "web push only — it never touches APNs or FCM — so without this the phone " +
      "hears nothing, which is the entire case this story exists for.",
  );
  // The link carries the item so a tap lands on that garment, not the queue.
  assert(
    /pendingDelists=1/.test(fn) && /item=\$\{itemId\}/.test(fn),
    "the in-app link no longer names the item",
  );
  // Best-effort: the rows are already ended and queued by this point.
  assert(
    /catch \(err\)/.test(fn) && !/throw /.test(fn),
    "notifyDelistNeeded can throw into an auto-end pass that has already done " +
      "the work that matters",
  );
});

Deno.test("US-3144: the push carries the one key both clients already parse", () => {
  const fn = PUSH.slice(PUSH.indexOf("export function pushDelistNeeded("));
  assert(fn.length > 200, "pushDelistNeeded is gone");
  assert(
    /category: "delist\.needed"/.test(fn),
    "the push category changed. It must match NotificationCategoryID.delistNeeded " +
      "(iOS) and PushCategory.DELIST_NEEDED (Android) byte for byte, or the tap " +
      "routes nowhere and the push is a dead end.",
  );
  assert(
    /inventory_item_id: opts\.itemId/.test(fn),
    "the item id no longer rides in data.inventory_item_id — the ONE key both " +
      "DeepLinkRoute.from (iOS) and PushCategory.route (Android) read",
  );
  assert(
    /collapseId: `delist-\$\{opts\.itemId\}`/.test(fn),
    "the collapse key is gone, so a re-send stacks a second notification about " +
      "the same garment instead of replacing the first",
  );
  // The copy has to earn asking for work.
  assert(
    /sells twice/.test(fn),
    "the push no longer says WHY the seller is being asked to act",
  );
});

Deno.test("US-3144: the item filter narrows, never widens", () => {
  // A phone arriving from a push about one item should see that item. The id
  // comes from the client, so it is applied ON TOP of the owner scope — a
  // foreign id must match nothing rather than reach somebody else's rows.
  const owner = PENDING.indexOf('.eq("inventory_items.user_id", ownerId)');
  const item = PENDING.indexOf('.eq("inventory_item_id", opts.itemId)');
  assert(owner > -1, "loadPendingDelists lost its owner scope");
  assert(item > -1, "the item filter is gone");
  assert(
    owner < item,
    "the item filter is applied before the owner scope — check that the owner " +
      "scope is still on the same query builder",
  );
  assert(
    /if \(opts\.itemId\) q = q\.eq/.test(PENDING),
    "the item filter is no longer optional, so the extension popup and the " +
      "dashboard (which pass no item) would get an empty list",
  );

  // The route validates it as a uuid rather than passing a raw string through.
  assert(
    /optionalUuid\(c\.req\.query\("item"\)\)/.test(ROUTE),
    "the item query param is no longer validated as a uuid",
  );
});
