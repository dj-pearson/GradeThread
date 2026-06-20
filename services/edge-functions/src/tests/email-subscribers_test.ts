import { assertEquals } from "@std/assert";
import {
  isValidSubscriberEmail,
  normalizeSubscriberEmail,
  subscriberStatusForSuppression,
} from "../lib/email-subscribers.ts";

// US-912: the pure capture helpers are env-free (only a type import from
// email-suppression.ts) so they unit-test without the supabase env dance.

Deno.test("normalizeSubscriberEmail trims + lowercases", () => {
  assertEquals(normalizeSubscriberEmail("  Foo@Example.COM "), "foo@example.com");
  assertEquals(normalizeSubscriberEmail(""), "");
  // deno-lint-ignore no-explicit-any
  assertEquals(normalizeSubscriberEmail(undefined as any), "");
});

Deno.test("isValidSubscriberEmail accepts plausible addresses", () => {
  for (const ok of ["a@b.co", "Foo.Bar+tag@sub.domain.com", "x@y.io"]) {
    assertEquals(isValidSubscriberEmail(ok), true, ok);
  }
});

Deno.test("isValidSubscriberEmail rejects malformed / dangerous input", () => {
  for (const bad of [
    "",
    "no-at-sign",
    "missing@tld",
    "@nolocal.com",
    "spaces in@email.com",
    "two@@at.com",
    "trailing@dot.",
    `${"a".repeat(250)}@example.com`, // > 254 chars
  ]) {
    assertEquals(isValidSubscriberEmail(bad), false, bad);
  }
});

Deno.test("subscriberStatusForSuppression maps reasons to subscriber status (AC4)", () => {
  assertEquals(subscriberStatusForSuppression("hard_bounce"), "bounced");
  assertEquals(subscriberStatusForSuppression("complaint"), "unsubscribed");
  assertEquals(subscriberStatusForSuppression("unsubscribe_all"), "unsubscribed");
  assertEquals(subscriberStatusForSuppression("manual"), "unsubscribed");
});
