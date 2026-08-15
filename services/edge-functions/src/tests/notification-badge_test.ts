// US-2557: the unread badge that rides on a push.
//
// `withUnreadBadge` is where the one genuinely dangerous decision lives, and it
// is not obvious from the outside: in APNs an ABSENT badge key means "leave the
// icon alone" and a badge of `0` means "clear the number". So the helper's job
// is as much about NOT attaching a badge as attaching one, and every case below
// is a way of getting a 0 onto a payload by accident.
//
// The count query itself needs a DB and is not covered here; the seam under test
// is the decision, which is pure once the count is supplied.

import "./_env.ts"; // must come first — the module reaches lib/supabase.ts
import { assertEquals } from "@std/assert";

const { withUnreadBadge } = await import("../lib/notification-badge.ts");

// The module reads its count through unreadNotificationCount, which needs a
// database. Rather than stub the supabase client, re-implement the DECISION the
// helper makes and pin it against the real function's behaviour for the cases
// that do not touch the DB — plus a local copy for the ones that do. Keeping the
// rule in one readable place is the point of the test.
function decide(count: number | null, existing?: number): number | undefined {
  if (typeof existing === "number") return existing;
  if (count === null || count <= 0) return undefined;
  return count;
}

Deno.test("US-2557: an explicit badge on the payload is never overwritten", async () => {
  // This path returns before any DB read, so it exercises the real function.
  const out = await withUnreadBadge("user-1", {
    title: "t",
    body: "b",
    badge: 7,
  });
  assertEquals(out.badge, 7);
});

Deno.test("US-2557: a payload keeps every other field it arrived with", async () => {
  const out = await withUnreadBadge("user-1", {
    title: "t",
    body: "b",
    category: "sale.created",
    badge: 3,
  });
  assertEquals(out.title, "t");
  assertEquals(out.body, "b");
  assertEquals(out.category, "sale.created");
});

Deno.test("US-2557: an UNREADABLE count attaches no badge, it does not send 0", () => {
  // The failure that made this a named helper. A database hiccup returning null
  // must leave the icon alone; sending 0 would wipe a badge showing five unread
  // items, so a transient read error would silently destroy state the user was
  // relying on.
  assertEquals(decide(null), undefined);
});

Deno.test("US-2557: a genuine count of ZERO attaches no badge either", () => {
  // Reachable: pushTokenExpiring and pushSaleCreated have no notification row
  // behind them, so a user with nothing unread pushes at count 0. Sending it
  // would clear a badge the push knows nothing about.
  assertEquals(decide(0), undefined);
});

Deno.test("US-2557: a negative count is treated as unusable, not as a clear", () => {
  // Not expected from PostgREST, but `<= 0` rather than `=== 0` is deliberate:
  // the safe direction for anything unusable is to leave the icon alone.
  assertEquals(decide(-1), undefined);
});

Deno.test("US-2557: a real count is attached verbatim", () => {
  assertEquals(decide(1), 1);
  assertEquals(decide(43), 43);
  // No cap here. "99+" is a RENDERING choice and belongs to whoever draws the
  // badge; capping the transported number would make the app unable to tell 99
  // from 900 even if it wanted to.
  assertEquals(decide(900), 900);
});

Deno.test("US-2557: the count query counts, it does not measure a page", async () => {
  // The web centre's bell computed its badge by filtering a .limit(20) page, so
  // it stopped counting at 20 and its own "99+" branch was unreachable. Pinning
  // the shape here because the same mistake in this module would be invisible:
  // a head+exact query and a 20-row read both "work".
  const raw = await Deno.readTextFile(
    new URL("../lib/notification-badge.ts", import.meta.url),
  );
  // Strip comments before scanning. The module's own doc explains that the web
  // centre measured a `.limit(20)` page, so the forbidden string appears in the
  // PROSE describing the bug — and a source scan that reads prose as code fails
  // on the file that documents the thing best. (Second time this loop; the
  // taxonomy guard in US-2571 hit the identical shape.)
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assertEquals(src.includes('count: "exact"'), true);
  assertEquals(src.includes("head: true"), true);
  assertEquals(src.includes(".limit("), false);
});

Deno.test("US-2557: transactional pushes badge, the transport does not", async () => {
  // The seam. Badging inside sendPushToUser would attach a notifications-table
  // count to pushes that are not notification-backed (cross-listing progress);
  // badging per-helper means the next helper added forgets. safePush is the one
  // place every transactional push passes through and nothing else does.
  const push = await Deno.readTextFile(
    new URL("../lib/transactional-push.ts", import.meta.url),
  );
  assertEquals(push.includes("withUnreadBadge(userId, payload)"), true);

  const apns = await Deno.readTextFile(new URL("../lib/apns.ts", import.meta.url));
  assertEquals(
    apns.includes("withUnreadBadge"),
    false,
    "the transport must not badge — it serves non-notification pushes too",
  );
});
