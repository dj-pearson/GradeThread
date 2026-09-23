// money.md action 5: the rules that keep a Stripe subscription webhook from
// overwriting newer or unrelated billing state. The route-level proof (a real
// signed event through /stripe, with a fake PostgREST) is
// subscription-webhook-order_test.ts; this file pins the decision table.

import { assertEquals } from "@std/assert";
import {
  ignoredEventType,
  isLiveSubscriptionStatus,
  judgeSubscriptionEvent,
  latestEventCreated,
  needsStoredStatus,
} from "../lib/subscription-event-guard.ts";

const T = 1_790_000_000;

Deno.test("an older change event after a newer one was applied is stale", () => {
  const v = judgeSubscriptionEvent({
    kind: "change",
    incomingSubscriptionId: "sub_A",
    eventCreated: T - 60,
    storedSubscriptionId: "sub_A",
    lastAppliedEventCreated: T,
  });
  assertEquals(v, { apply: false, reason: "stale_event" });
});

Deno.test("a newer change event applies; so does a retry of the watermark event itself", () => {
  for (const created of [T + 1, T]) {
    const v = judgeSubscriptionEvent({
      kind: "change",
      incomingSubscriptionId: "sub_A",
      eventCreated: created,
      storedSubscriptionId: "sub_A",
      lastAppliedEventCreated: T,
    });
    assertEquals(v, { apply: true }, `created=${created}`);
  }
});

Deno.test("with no watermark yet (first event, or legacy rows) the change applies", () => {
  const v = judgeSubscriptionEvent({
    kind: "change",
    incomingSubscriptionId: "sub_A",
    eventCreated: T,
    storedSubscriptionId: null,
    lastAppliedEventCreated: null,
  });
  assertEquals(v, { apply: true });
});

Deno.test("a change for a non-current sub does not overwrite while the current one is live", () => {
  for (const status of ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"]) {
    const v = judgeSubscriptionEvent({
      kind: "change",
      incomingSubscriptionId: "sub_OLD",
      eventCreated: T,
      storedSubscriptionId: "sub_CURRENT",
      lastAppliedEventCreated: null,
      storedSubscriptionStatus: status,
    });
    assertEquals(v, { apply: false, reason: "not_current_subscription" }, status);
  }
});

Deno.test("a change for another sub is adopted once the stored one is dead in Stripe", () => {
  // The genuine replacement: old canceled, new created, delivered in either order.
  for (const status of ["canceled", "incomplete_expired", "missing"]) {
    const v = judgeSubscriptionEvent({
      kind: "change",
      incomingSubscriptionId: "sub_NEW",
      eventCreated: T,
      storedSubscriptionId: "sub_OLD",
      lastAppliedEventCreated: null,
      storedSubscriptionStatus: status,
    });
    assertEquals(v, { apply: true }, status);
  }
});

Deno.test("unknown stored status keeps the current subscription (fail safe)", () => {
  const v = judgeSubscriptionEvent({
    kind: "change",
    incomingSubscriptionId: "sub_OTHER",
    eventCreated: T,
    storedSubscriptionId: "sub_CURRENT",
    lastAppliedEventCreated: null,
    storedSubscriptionStatus: null,
  });
  assertEquals(v, { apply: false, reason: "not_current_subscription" });
});

Deno.test("deleting a non-current sub is ignored; deleting the current one applies", () => {
  assertEquals(
    judgeSubscriptionEvent({
      kind: "delete",
      incomingSubscriptionId: "sub_DUP",
      eventCreated: T,
      storedSubscriptionId: "sub_CURRENT",
      lastAppliedEventCreated: null,
    }),
    { apply: false, reason: "not_current_subscription" },
  );
  assertEquals(
    judgeSubscriptionEvent({
      kind: "delete",
      incomingSubscriptionId: "sub_CURRENT",
      eventCreated: T,
      storedSubscriptionId: "sub_CURRENT",
      lastAppliedEventCreated: null,
    }),
    { apply: true },
  );
});

Deno.test("a deletion is never discarded as stale", () => {
  const v = judgeSubscriptionEvent({
    kind: "delete",
    incomingSubscriptionId: "sub_A",
    eventCreated: T - 600,
    storedSubscriptionId: "sub_A",
    lastAppliedEventCreated: T,
  });
  assertEquals(v, { apply: true });
});

Deno.test("needsStoredStatus only for a change naming a different subscription", () => {
  assertEquals(needsStoredStatus("change", "sub_B", "sub_A"), true);
  assertEquals(needsStoredStatus("change", "sub_A", "sub_A"), false);
  assertEquals(needsStoredStatus("change", "sub_A", null), false);
  assertEquals(needsStoredStatus("delete", "sub_B", "sub_A"), false);
});

Deno.test("latestEventCreated takes the max and skips rows without a watermark", () => {
  assertEquals(latestEventCreated(null), null);
  assertEquals(latestEventCreated([{}, { event_created: null }]), null);
  assertEquals(
    latestEventCreated([{ event_created: T }, { event_created: String(T + 5) }, { event_created: T - 9 }, {
      event_created: "x",
    }]),
    T + 5,
  );
});

Deno.test("isLiveSubscriptionStatus and ignoredEventType", () => {
  assertEquals(isLiveSubscriptionStatus("active"), true);
  assertEquals(isLiveSubscriptionStatus("canceled"), false);
  assertEquals(isLiveSubscriptionStatus("missing"), false);
  assertEquals(ignoredEventType("customer.subscription.deleted"), "ignored.customer.subscription.deleted");
});
