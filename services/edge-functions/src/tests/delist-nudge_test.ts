// US-3453: the no-drain nudge's judgements, with a fixed clock.

import { assert, assertEquals } from "@std/assert";
import {
  DELIST_NUDGE_PREF_KEY,
  groupByOwner,
  NUDGE_AFTER_MINUTES,
  NUDGE_REPEAT_HOURS,
  nudgeChannels,
  nudgeNotice,
  type NudgeQueueRow,
  shouldNudge,
} from "../lib/delist-nudge.ts";

const NOW = new Date("2026-09-21T15:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function row(over: Partial<NudgeQueueRow> & { id: string }): NudgeQueueRow {
  return {
    user_id: "A",
    platform: "poshmark",
    inventory_item_id: "item-1",
    listing_id: "l-1",
    created_at: minutesAgo(45),
    expires_at: "2026-09-30T00:00:00Z",
    ...over,
  };
}

Deno.test("a delist queued past the threshold with no drain since and no recent notice is nudged", () => {
  const v = shouldNudge({ rows: [row({ id: "q1" })], lastDrainedAt: null, lastNoticeAt: minutesAgo(90), now: NOW });
  assert(v.notify);
  assertEquals(v.rows.map((r) => r.id), ["q1"]);
});

Deno.test("a row younger than the threshold is not old enough", () => {
  const v = shouldNudge({
    rows: [row({ id: "q1", created_at: minutesAgo(NUDGE_AFTER_MINUTES - 1) })],
    lastDrainedAt: null,
    lastNoticeAt: null,
    now: NOW,
  });
  assertEquals(v, { notify: false, reason: "nothing_old_enough" });
});

Deno.test("an expired row does not count: it is reported elsewhere as dead", () => {
  const v = shouldNudge({
    rows: [row({ id: "q1", expires_at: minutesAgo(1) })],
    lastDrainedAt: null,
    lastNoticeAt: null,
    now: NOW,
  });
  assertEquals(v, { notify: false, reason: "nothing_old_enough" });
});

Deno.test("a browser that drained after the row was queued means the drain is alive; no nudge", () => {
  const v = shouldNudge({
    rows: [row({ id: "q1", created_at: minutesAgo(45) })],
    lastDrainedAt: minutesAgo(10),
    lastNoticeAt: null,
    now: NOW,
  });
  assertEquals(v, { notify: false, reason: "drained_since" });
  // A drain BEFORE the row was queued says nothing about this row.
  const v2 = shouldNudge({
    rows: [row({ id: "q1", created_at: minutesAgo(45) })],
    lastDrainedAt: minutesAgo(60),
    lastNoticeAt: null,
    now: NOW,
  });
  assert(v2.notify);
});

Deno.test("at most one notice an hour: the sale-time notice counts", () => {
  const told = shouldNudge({
    rows: [row({ id: "q1" })],
    lastDrainedAt: null,
    lastNoticeAt: minutesAgo(NUDGE_REPEAT_HOURS * 60 - 5),
    now: NOW,
  });
  assertEquals(told, { notify: false, reason: "told_recently" });
  const again = shouldNudge({
    rows: [row({ id: "q1" })],
    lastDrainedAt: null,
    lastNoticeAt: minutesAgo(NUDGE_REPEAT_HOURS * 60 + 1),
    now: NOW,
  });
  assert(again.notify);
});

Deno.test("two sellers' rows never share a verdict or a notice (US-268)", () => {
  const groups = groupByOwner([
    row({ id: "a1", user_id: "A" }),
    row({ id: "b1", user_id: "B", inventory_item_id: "item-b" }),
    row({ id: "a2", user_id: "A", platform: "mercari" }),
  ]);
  assertEquals([...groups.keys()].sort(), ["A", "B"]);
  assertEquals(groups.get("A")!.map((r) => r.id), ["a1", "a2"]);
  assertEquals(groups.get("B")!.map((r) => r.id), ["b1"]);
  const forA = shouldNudge({ rows: groups.get("A")!, lastDrainedAt: null, lastNoticeAt: null, now: NOW });
  assert(forA.notify);
  assert(forA.rows.every((r) => r.user_id === "A"));
});

Deno.test("the notice names every listing by marketplace and garment, and links to the one item when there is one", () => {
  const one = nudgeNotice([{ platform: "poshmark", itemId: "item-1", itemTitle: "Nike Windbreaker", listingUrl: null }]);
  assertEquals(one.title, "Still live: nothing has ended it");
  assert(one.message.startsWith('"Nike Windbreaker" on Poshmark sold elsewhere and is still up'));
  assert(one.message.includes("Open your browser"));
  assert(one.message.includes("end them now on your phone"));
  assertEquals(one.link, "/dashboard/flipdesk/inventory?item=item-1&pendingDelists=1");

  const two = nudgeNotice([
    { platform: "poshmark", itemId: "item-1", itemTitle: "Nike Windbreaker", listingUrl: null },
    { platform: "facebook", itemId: "item-2", itemTitle: null, listingUrl: null },
  ]);
  assertEquals(two.title, "Still live: 2 listings");
  assert(two.message.includes('"Nike Windbreaker" on Poshmark and an item on Facebook Marketplace'));
  assertEquals(two.link, "/dashboard/flipdesk/inventory?pendingDelists=1");
});

Deno.test("the nudge is gated on the delist_reminders category, the one the sale-time notice uses", async () => {
  assertEquals(DELIST_NUDGE_PREF_KEY, "delist_reminders");
  const notify = await Deno.readTextFile(new URL("../lib/notify.ts", import.meta.url));
  assert(notify.includes('delist_needed: "delist_reminders"'));
  const route = await Deno.readTextFile(new URL("../routes/jobs-delist-nudge.ts", import.meta.url));
  assert(route.includes('type: "delist_needed"'), "the job sends through notifyUser as delist_needed");
  assert(route.includes("pushDelistNeeded("), "the job reaches the phone through the delist.needed category");
});

Deno.test("a seller who turned delist reminders off gets nothing; default is on; one channel can stay open", () => {
  assertEquals(nudgeChannels(null), { inApp: true, push: true });
  assertEquals(nudgeChannels({}), { inApp: true, push: true });
  assertEquals(nudgeChannels({ delist_reminders: { in_app: false, push: false } }), { inApp: false, push: false });
  assertEquals(nudgeChannels({ delist_reminders: { push: false } }), { inApp: true, push: false });
  // Another category's switch says nothing about this one.
  assertEquals(nudgeChannels({ selling_activity: { in_app: false, push: false } }), { inApp: true, push: true });
});

Deno.test("the job decides the seller's channels before either send, and never pushes a closed phone channel", async () => {
  const route = await Deno.readTextFile(new URL("../routes/jobs-delist-nudge.ts", import.meta.url));
  const decide = route.indexOf("nudgeChannels(await prefsFor(userId))");
  const inApp = route.indexOf("notifyUser(userId, { type: \"delist_needed\"");
  const push = route.indexOf("pushDelistNeeded(userId");
  assert(decide > 0 && inApp > decide && push > inApp, "channels are read first, then in-app, then push");
  assert(route.includes("if (channels.push) {"), "the phone push is inside the push gate");
  assert(route.includes("if (!channels.inApp && !channels.push) {"), "both closed means no send at all");
});
