import { assertEquals } from "@std/assert";
import {
  type ConfirmedSubscriber,
  normalizeBroadcastEmail,
  partitionExtraSubscribers,
} from "../lib/broadcast-audience.ts";

// US-925: the segment∪subscriber dedup is pure (no supabase/env) so it tests
// directly (mirrors newsletter-schedule_test.ts).

Deno.test("normalizeBroadcastEmail trims + lowercases", () => {
  assertEquals(normalizeBroadcastEmail("  Foo@Bar.COM "), "foo@bar.com");
  assertEquals(normalizeBroadcastEmail(""), "");
});

Deno.test("partitionExtraSubscribers de-dupes against the segment", () => {
  const seen = new Set(["a@x.com", "b@x.com"]); // already mailed by the segment
  const subs: ConfirmedSubscriber[] = [
    { email: "A@x.com", user_id: "u1" }, // dup of segment (case-insensitive)
    { email: "c@x.com", user_id: "u3" }, // new + linked → extra
    { email: "d@x.com", user_id: null }, // new but no account → skipped
  ];
  const { extras, skippedNoAccount, duplicates } = partitionExtraSubscribers(subs, seen);
  assertEquals(extras, [{ userId: "u3", email: "c@x.com" }]);
  assertEquals(skippedNoAccount, 1);
  assertEquals(duplicates, 1);
  // The segment's emails are left intact + the new one folded in.
  assertEquals(seen.has("c@x.com"), true);
});

Deno.test("partitionExtraSubscribers collapses duplicate subscribers", () => {
  const seen = new Set<string>();
  const subs: ConfirmedSubscriber[] = [
    { email: "x@y.com", user_id: "u1" },
    { email: "X@Y.com", user_id: "u1" }, // same address twice
    { email: "  ", user_id: "u2" }, // unusable address — dropped silently
  ];
  const { extras, skippedNoAccount, duplicates } = partitionExtraSubscribers(subs, seen);
  assertEquals(extras, [{ userId: "u1", email: "x@y.com" }]);
  assertEquals(skippedNoAccount, 0);
  assertEquals(duplicates, 1);
});

Deno.test("partitionExtraSubscribers: an empty list yields nothing", () => {
  const { extras, skippedNoAccount, duplicates } = partitionExtraSubscribers([], new Set());
  assertEquals(extras.length, 0);
  assertEquals(skippedNoAccount, 0);
  assertEquals(duplicates, 0);
});
