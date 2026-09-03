// US-1964: eBay Notification API subscription management — pure planning +
// health logic.
//
// These are the decisions that decide whether inbound sync works at all: which
// topics we subscribe, to which destination, and whether a config that "looks"
// subscribed actually delivers to us. The lib imports ebay-client transitively
// (→ the service-role supabase client), so set dummy env BEFORE the dynamic
// import — same pattern as the other edge tests.
//   deno test --allow-env --allow-read src/tests/ebay-notification-subscriptions_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  REQUIRED_BUCKETS,
  destinationKindForBucket,
  destinationNameFor,
  idFromLocation,
  pickHttpsJsonSchemaVersion,
  planSubscriptionActions,
  summarizeNotificationHealth,
  topicsByBucket,
} = await import("../lib/ebay-notification-subscriptions.ts");

const DEST = { general: "dest-general", deletion: "dest-deletion" };

// A representative slice of eBay's catalog: one topic per required bucket, all
// enabled and offering an HTTPS+JSON payload.
const TOPICS = [
  { topicId: "ORDER_PAYMENT_COMPLETED", status: "ENABLED", schemaVersion: "1.0" },
  { topicId: "FINANCES_PAYOUT_STATUS_CHANGED", status: "ENABLED", schemaVersion: "1.0" },
  { topicId: "ORDER_RETURN_REQUESTED", status: "ENABLED", schemaVersion: "1.0" },
  // US-2656: the listing lifecycle. Before that bucket existed this topic
  // classified as `unhandled`, and an unhandled topic is never subscribed — so
  // a listing ending on eBay was never delivered at all.
  { topicId: "ITEM_CLOSED", status: "ENABLED", schemaVersion: "1.0" },
  { topicId: "MARKETPLACE_ACCOUNT_DELETION", status: "ENABLED", schemaVersion: "1.0" },
];

const enabledSub = (topicId: string, destinationId: string) => ({
  subscriptionId: `sub-${topicId}`,
  topicId,
  status: "ENABLED",
  destinationId,
});

// Every required topic subscribed, enabled, and pointed at the right place.
const healthySubs = [
  enabledSub("ORDER_PAYMENT_COMPLETED", DEST.general),
  enabledSub("FINANCES_PAYOUT_STATUS_CHANGED", DEST.general),
  enabledSub("ORDER_RETURN_REQUESTED", DEST.general),
  enabledSub("ITEM_CLOSED", DEST.general),
  enabledSub("MARKETPLACE_ACCOUNT_DELETION", DEST.deletion),
];

Deno.test("payload picker takes the HTTPS+JSON schemaVersion and ignores others", () => {
  assertEquals(
    pickHttpsJsonSchemaVersion([
      { format: "XML", schemaVersion: "9.9", deliveryProtocol: "HTTPS" },
      { format: "JSON", schemaVersion: "2.5", deliveryProtocol: "HTTPS" },
    ]),
    "2.5",
  );
  // No HTTPS+JSON payload → unsubscribable by us; must not guess a version.
  assertEquals(
    pickHttpsJsonSchemaVersion([{ format: "JSON", schemaVersion: "1.0", deliveryProtocol: "AMQP" }]),
    null,
  );
  assertEquals(pickHttpsJsonSchemaVersion(undefined), null);
});

// The reconcile cron died in production with
// "(p.format ?? \"\").toUpperCase is not a function": eBay sent a payload whose
// fields were not the strings our interface promised. The picker is the only
// thing standing between eBay's JSON and a 500 on every tick, so it has to be
// total over shapes we did not anticipate.
Deno.test("payload picker survives non-string fields from eBay", () => {
  // Arrays (eBay documents `deliveryProtocols` plural on some topics).
  assertEquals(
    pickHttpsJsonSchemaVersion([
      { format: ["JSON"], schemaVersion: "3.1", deliveryProtocol: ["HTTPS", "AMQP"] },
    ]),
    "3.1",
  );
  // Objects wrapping the value.
  assertEquals(
    pickHttpsJsonSchemaVersion([
      {
        format: { value: "json" },
        schemaVersion: { value: "1.7" },
        deliveryProtocol: { value: "https" },
      },
    ]),
    "1.7",
  );
  // A numeric schemaVersion still comes back as the string eBay wants echoed.
  assertEquals(
    pickHttpsJsonSchemaVersion([
      { format: "JSON", schemaVersion: 2, deliveryProtocol: "HTTPS" },
    ]),
    "2",
  );
  // Shapes with nothing recoverable read as "not HTTPS+JSON" — null, not a throw.
  assertEquals(
    pickHttpsJsonSchemaVersion([
      { format: 7, schemaVersion: true, deliveryProtocol: null },
      { format: "JSON", schemaVersion: null, deliveryProtocol: "HTTPS" },
      null as unknown as { format?: unknown },
    ]),
    null,
  );
});

Deno.test("topics are bucketed by the SAME router the receiver uses", () => {
  const byBucket = topicsByBucket([
    ...TOPICS,
    { topicId: "SOMETHING_WE_IGNORE", status: "ENABLED", schemaVersion: "1.0" },
  ]);
  assertEquals(byBucket.get("order")?.map((t) => t.topicId), ["ORDER_PAYMENT_COMPLETED"]);
  assertEquals(byBucket.get("payout")?.map((t) => t.topicId), ["FINANCES_PAYOUT_STATUS_CHANGED"]);
  // ORDER_RETURN_REQUESTED contains "ORDER" but must land in `return`.
  assertEquals(byBucket.get("return")?.map((t) => t.topicId), ["ORDER_RETURN_REQUESTED"]);
  assertEquals(byBucket.get("listing")?.map((t) => t.topicId), ["ITEM_CLOSED"]);
  assertEquals(
    byBucket.get("account_deletion")?.map((t) => t.topicId),
    ["MARKETPLACE_ACCOUNT_DELETION"],
  );
  // An unhandled topic is never a bucket of its own.
  assertEquals([...byBucket.keys()].includes("unhandled" as never), false);
});

Deno.test("account-deletion routes to the compliance endpoint, everything else to the general one", () => {
  assertEquals(destinationKindForBucket("account_deletion"), "deletion");
  for (const bucket of ["order", "payout", "return", "listing"] as const) {
    assertEquals(destinationKindForBucket(bucket), "general");
  }
});

Deno.test("destination names are env-scoped so sandbox can't collide with prod", () => {
  assert(destinationNameFor("general", "sandbox") !== destinationNameFor("general", "production"));
  assert(destinationNameFor("general", "production") !== destinationNameFor("deletion", "production"));
});

Deno.test("AC3: a fully-subscribed config plans NO writes (re-running is a no-op)", () => {
  const plan = planSubscriptionActions({
    topics: TOPICS,
    subscriptions: healthySubs,
    destinationIds: DEST,
  });
  assertEquals(plan.create, []);
  assertEquals(plan.enable, []);
  assertEquals(plan.repoint, []);
});

Deno.test("AC1: unsubscribed topics are planned for creation against the right destination", () => {
  const plan = planSubscriptionActions({
    topics: TOPICS,
    subscriptions: [],
    destinationIds: DEST,
  });
  assertEquals(plan.create.length, 5);
  const byTopic = new Map(plan.create.map((a) => [a.topicId, a]));
  assertEquals(byTopic.get("ORDER_PAYMENT_COMPLETED")?.destinationId, DEST.general);
  assertEquals(byTopic.get("FINANCES_PAYOUT_STATUS_CHANGED")?.destinationId, DEST.general);
  assertEquals(byTopic.get("ORDER_RETURN_REQUESTED")?.destinationId, DEST.general);
  assertEquals(byTopic.get("ITEM_CLOSED")?.destinationId, DEST.general);
  // The compliance topic must NEVER be pointed at the general receiver, which
  // would classify it as unhandled and drop it.
  assertEquals(byTopic.get("MARKETPLACE_ACCOUNT_DELETION")?.destinationId, DEST.deletion);
  assertEquals(byTopic.get("ORDER_PAYMENT_COMPLETED")?.schemaVersion, "1.0");
});

Deno.test("AC3: an existing DISABLED subscription is enabled in place, never duplicated", () => {
  const plan = planSubscriptionActions({
    topics: TOPICS,
    subscriptions: [
      { ...enabledSub("ORDER_PAYMENT_COMPLETED", DEST.general), status: "DISABLED" },
      ...healthySubs.slice(1),
    ],
    destinationIds: DEST,
  });
  assertEquals(plan.create, []); // <- the duplicate-subscription trap
  assertEquals(plan.enable.map((e) => e.topicId), ["ORDER_PAYMENT_COMPLETED"]);
  assertEquals(plan.enable[0].subscriptionId, "sub-ORDER_PAYMENT_COMPLETED");
});

Deno.test("a subscription pointing at a foreign destination is re-pointed, not duplicated", () => {
  const plan = planSubscriptionActions({
    topics: TOPICS,
    subscriptions: [
      enabledSub("ORDER_PAYMENT_COMPLETED", "someone-elses-destination"),
      ...healthySubs.slice(1),
    ],
    destinationIds: DEST,
  });
  assertEquals(plan.create, []);
  assertEquals(plan.repoint.map((r) => r.topicId), ["ORDER_PAYMENT_COMPLETED"]);
  assertEquals(plan.repoint[0].destinationId, DEST.general);
  assertEquals(plan.repoint[0].subscriptionId, "sub-ORDER_PAYMENT_COMPLETED");
});

Deno.test("topics we can't subscribe are skipped with a reason, not silently dropped", () => {
  const plan = planSubscriptionActions({
    topics: [
      { topicId: "ORDER_PAYMENT_COMPLETED", status: "ENABLED", schemaVersion: null },
      { topicId: "FINANCES_PAYOUT_STATUS_CHANGED", status: "DISABLED", schemaVersion: "1.0" },
    ],
    subscriptions: [],
    destinationIds: DEST,
  });
  assertEquals(plan.create, []);
  assertEquals(plan.skipped.length, 2);
  assert(plan.skipped.some((s) => s.topicId === "ORDER_PAYMENT_COMPLETED"));
  assert(plan.skipped.some((s) => s.topicId === "FINANCES_PAYOUT_STATUS_CHANGED"));
});

Deno.test("a missing destination skips its topics rather than creating a broken subscription", () => {
  const plan = planSubscriptionActions({
    topics: TOPICS,
    subscriptions: [],
    destinationIds: { general: null, deletion: DEST.deletion },
  });
  // Only the account-deletion topic can be created; the rest have no home.
  assertEquals(plan.create.map((a) => a.topicId), ["MARKETPLACE_ACCOUNT_DELETION"]);
  assertEquals(plan.skipped.length, 4);
});

Deno.test("onlyBuckets narrows the plan", () => {
  const plan = planSubscriptionActions({
    topics: TOPICS,
    subscriptions: [],
    destinationIds: DEST,
    onlyBuckets: ["payout"],
  });
  assertEquals(plan.create.map((a) => a.topicId), ["FINANCES_PAYOUT_STATUS_CHANGED"]);
});

Deno.test("AC2: health reports every required bucket as healthy when fully subscribed", () => {
  const health = summarizeNotificationHealth({
    env: "production",
    topics: TOPICS,
    subscriptions: healthySubs,
    destinationIds: DEST,
  });
  assertEquals(health.ok, true);
  assertEquals(health.missingBuckets, []);
  assertEquals(health.env, "production");
  assertEquals(health.buckets.map((b) => b.bucket), [...REQUIRED_BUCKETS]);
  assert(health.buckets.every((b) => b.healthy));
});

Deno.test("AC2/AC4: an unsubscribed topic surfaces as a missing bucket", () => {
  const health = summarizeNotificationHealth({
    env: "sandbox",
    topics: TOPICS,
    // payout never subscribed
    subscriptions: healthySubs.filter((s) => s.topicId !== "FINANCES_PAYOUT_STATUS_CHANGED"),
    destinationIds: DEST,
  });
  assertEquals(health.ok, false);
  assertEquals(health.missingBuckets, ["payout"]);
  const payout = health.buckets.find((b) => b.bucket === "payout");
  assertEquals(payout?.topics[0].subscribed, false);
});

Deno.test("a DISABLED subscription is reported unhealthy even though it exists", () => {
  const health = summarizeNotificationHealth({
    env: "production",
    topics: TOPICS,
    subscriptions: [
      { ...enabledSub("ORDER_PAYMENT_COMPLETED", DEST.general), status: "DISABLED" },
      ...healthySubs.slice(1),
    ],
    destinationIds: DEST,
  });
  assertEquals(health.missingBuckets, ["order"]);
  const order = health.buckets.find((b) => b.bucket === "order");
  assertEquals(order?.topics[0].subscribed, true);
  assertEquals(order?.topics[0].status, "DISABLED");
});

Deno.test("an ENABLED subscription delivering elsewhere is misrouted → unhealthy", () => {
  // The nastiest case: eBay's console says ENABLED, but the events land at a
  // destination we don't own, so nothing ever reaches us.
  const health = summarizeNotificationHealth({
    env: "production",
    topics: TOPICS,
    subscriptions: [
      enabledSub("ORDER_PAYMENT_COMPLETED", "some-old-destination"),
      ...healthySubs.slice(1),
    ],
    destinationIds: DEST,
  });
  assertEquals(health.ok, false);
  assertEquals(health.missingBuckets, ["order"]);
  const order = health.buckets.find((b) => b.bucket === "order");
  assertEquals(order?.topics[0].misrouted, true);
});

Deno.test("account-deletion subscribed to the GENERAL destination counts as misrouted", () => {
  // It would be dropped as an unhandled topic by the general receiver — a
  // compliance failure that looks fine in eBay's portal.
  const health = summarizeNotificationHealth({
    env: "production",
    topics: TOPICS,
    subscriptions: [
      // everything that legitimately lives on the general destination, then the
      // compliance topic misrouted onto it
      ...healthySubs.slice(0, 4),
      enabledSub("MARKETPLACE_ACCOUNT_DELETION", DEST.general),
    ],
    destinationIds: DEST,
  });
  assertEquals(health.missingBuckets, ["account_deletion"]);
});

Deno.test("a bucket with no destination yet is reported missing, not healthy", () => {
  const health = summarizeNotificationHealth({
    env: "sandbox",
    topics: TOPICS,
    subscriptions: healthySubs,
    destinationIds: { general: null, deletion: DEST.deletion },
  });
  assertEquals(health.ok, false);
  // order/payout/return/listing all live on the general destination.
  assertEquals(health.missingBuckets, ["order", "payout", "return", "listing"]);
});

Deno.test("a bucket eBay's catalog has no topic for is reported missing", () => {
  const health = summarizeNotificationHealth({
    env: "production",
    topics: TOPICS.filter((t) => t.topicId !== "FINANCES_PAYOUT_STATUS_CHANGED"),
    subscriptions: healthySubs,
    destinationIds: DEST,
  });
  assert(health.missingBuckets.includes("payout"));
  assertEquals(health.buckets.find((b) => b.bucket === "payout")?.topics, []);
});

Deno.test("destination id is parsed out of eBay's Location header", () => {
  assertEquals(
    idFromLocation("https://api.ebay.com/commerce/notification/v1/destination/dest-123"),
    "dest-123",
  );
  assertEquals(idFromLocation("/commerce/notification/v1/destination/abc?x=1"), "abc");
  assertEquals(idFromLocation(null), null);
  assertEquals(idFromLocation(""), null);
});
