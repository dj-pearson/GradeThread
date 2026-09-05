// US-3065 AC3: the enqueue path, now that something other than a route calls it.
//
// The whole path moved out of routes/flipdesk-extension-queue.ts so the Claude
// connector can reach it without a second copy of five separate refusals. A
// refactor is exactly when an ORDER gets scrambled, and every refusal here is
// ordered on purpose:
//
//   the entitlement gate    before anything, so a locked account writes nothing
//   the credential refusal  before any database call at all
//   the ownership checks    before the insert (US-268)
//   the depth cap           before the insert
//
// Neither half of this function can be driven from a test: supabaseAdmin is a
// Proxy whose `get` trap always resolves to the real client (supabase.ts:76), so
// it cannot be stubbed, and the client captures fetch at construction. That is
// the same wall US-2662 hit. So the behavioural half lives in the route's own
// suite and in tenant-isolation_test.ts; what is asserted here is the thing a
// behavioural test would NOT catch — that the order survived the move.
import assert from "node:assert/strict";

const SRC = await Deno.readTextFile(
  new URL("../lib/extension-enqueue.ts", import.meta.url),
);
const ROUTE = await Deno.readTextFile(
  new URL("../routes/flipdesk-extension-queue.ts", import.meta.url),
);

/** Index of the first occurrence, or -1, with the marker named on failure. */
function at(haystack: string, needle: string, label: string): number {
  const i = haystack.indexOf(needle);
  assert.notEqual(i, -1, `${label} is gone from extension-enqueue.ts — re-check this ordering`);
  return i;
}

Deno.test("US-3065: the credential refusal comes before any database call", () => {
  // The bright line. The queue stores WHAT to do and never a marketplace
  // password, and the table's CHECK would also reject it — but a refusal that
  // ran after an ownership SELECT would mean a caller could probe for the
  // existence of another tenant's item with a payload that was never legal.
  const refusal = at(SRC, 'payload may not contain', "the credential refusal");
  const firstDbCall = at(SRC, 'from("inventory_items")', "the item ownership check");
  assert.ok(
    refusal < firstDbCall,
    "a credential-carrying payload reaches a database call before being refused",
  );
});

Deno.test("US-3065: both ownership checks come before the insert (US-268)", () => {
  const item = at(SRC, 'from("inventory_items")', "the item ownership check");
  const listing = at(SRC, 'from("listings")', "the listing ownership check");
  const insert = at(SRC, 'from("extension_work_queue")\n    .insert', "the insert");
  assert.ok(item < insert, "the item ownership check runs after the insert");
  assert.ok(listing < insert, "the listing ownership check runs after the insert");

  // And both are scoped. An unverified id would let one tenant queue work
  // against another's item and, once drained, read that item's title and photos
  // into their own browser.
  const scoped = SRC.match(/\.eq\("user_id", ownerId\)/g) ?? [];
  assert.ok(
    scoped.length >= 4,
    `only ${scoped.length} queries are tenant-scoped; the ownership checks, the ` +
      `settings read, the expiry sweep and the depth count all need it`,
  );
});

Deno.test("US-3065: the depth cap is checked before the insert", () => {
  // Without it a seller queues 400 jobs over a week, opens their laptop, and
  // the extension starts opening marketplace tabs it will not stop opening.
  const cap = at(SRC, "MAX_QUEUE_DEPTH", "the depth cap");
  const insert = at(SRC, 'from("extension_work_queue")\n    .insert', "the insert");
  assert.ok(cap < insert, "the depth cap is checked after the row is already written");
});

Deno.test("US-3065: the gate runs first and can only be skipped explicitly", () => {
  const gate = at(SRC, "sellerQueueGate(ownerId)", "the entitlement gate");
  const kindCheck = at(SRC, "EXTENSION_QUEUE_KINDS.includes", "the kind check");
  assert.ok(gate < kindCheck, "the entitlement gate no longer runs first");

  // skipGate exists so a caller that already gated does not pay twice. It must
  // default to RUNNING: a caller that forgets the option must get the gate, not
  // lose it.
  assert.match(SRC, /if \(!opts\.skipGate\)/);
  assert.match(SRC, /opts: \{ skipGate\?: boolean \} = \{\}/);
});

Deno.test("US-3065: the route delegates rather than keeping a second copy", () => {
  // The point of the extraction. If the handler ever grows its own insert
  // again, the connector and the HTTP caller are back to two paths.
  assert.match(ROUTE, /enqueueExtensionWork\(ownerId, body as Record<string, unknown>\)/);
  const post = ROUTE.slice(
    ROUTE.indexOf('flipdeskExtensionQueueRoutes.post("/", async (c) => {'),
    ROUTE.indexOf("flipdeskExtensionQueueRoutes.get("),
  );
  assert.ok(post.length > 100, "the POST handler moved; re-check this test");
  assert.ok(
    !post.includes(".insert("),
    "the POST handler writes its own row again instead of delegating",
  );
  assert.ok(
    !post.includes("normalizeQueuePayload"),
    "the POST handler re-checks the payload itself, so there are two rules again",
  );
});

Deno.test("US-3065: a 500 keeps its cause out of the caller's body", () => {
  // The refusal union carries the driver message in `body.cause` so failSafe can
  // log it. The route must pass that to failSafe and NOT spread it into the
  // response, or a database error message reaches an API client.
  assert.match(ROUTE, /result\.body\?\.cause/);
  const post = ROUTE.slice(
    ROUTE.indexOf('flipdeskExtensionQueueRoutes.post("/", async (c) => {'),
    ROUTE.indexOf("flipdeskExtensionQueueRoutes.get("),
  );
  const spreadAt = post.indexOf("...(result.body ?? {})");
  const guardAt = post.indexOf("result.status === 500");
  assert.ok(spreadAt > -1 && guardAt > -1, "the 500 branch or the spread moved");
  assert.ok(
    guardAt < spreadAt,
    "the 500 branch must return BEFORE the body spread, or the driver message " +
      "is spread into the response",
  );
});

Deno.test("US-3065: the queued notice is still THE sentence, not a second one", () => {
  // Four clients mirror QUEUED_NOTICE byte-for-byte. The API returning its own
  // wording is the drift this was fixed for once already.
  assert.match(SRC, /notice: QUEUED_NOTICE/);
  assert.ok(
    !/notice: "/.test(SRC),
    "extension-enqueue.ts writes its own notice string instead of QUEUED_NOTICE",
  );
});
