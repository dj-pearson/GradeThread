// US-9113: what the connector's audit log keeps, and what it refuses to.
//
// The audit row is retained for 400 days, so anything it stores is stored for
// 400 days. That makes redaction a retention decision as much as a privacy one:
// an unredacted row is a second copy of the data it exists to describe, kept
// longer than the thing it describes.
//
// The rule the tests below pin: keep the IDS an investigation needs, summarise
// everything else to a shape, and drop anything that could be a credential
// outright - a shape summary of a secret still leaks its length.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { redactArguments } = await import("../lib/mcp-audit.ts");

Deno.test("ids and short enum values are kept verbatim, because they are the investigation", () => {
  const out = redactArguments({
    item_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    marketplace: "ebay",
    status: "active",
    mode: "confirm",
  });
  assertEquals(out.item_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assertEquals(out.marketplace, "ebay");
  assertEquals(out.status, "active");
  assertEquals(out.mode, "confirm");
});

Deno.test("free text becomes a length, not content", () => {
  const description = "A".repeat(812);
  const out = redactArguments({ description });
  assertEquals(out.description, { type: "string", length: 812 });
  assert(!JSON.stringify(out).includes("AAAA"), "the description content was stored");
});

Deno.test("image arrays become a count, so the log is not a copy of the photos", () => {
  const out = redactArguments({ images: ["base64...", "base64...", "base64..."] });
  assertEquals(out.images, { type: "array", length: 3 });
});

Deno.test("nested objects become a key count", () => {
  const out = redactArguments({ filters: { brand: "Carhartt", size: "L", status: "listed" } });
  assertEquals(out.filters, { type: "object", keys: 3 });
});

Deno.test("anything credential-shaped is dropped entirely, not summarised", () => {
  // A shape summary of a secret still tells an attacker its length, which for a
  // fixed-format credential is most of the way to identifying it.
  const out = redactArguments({
    confirm_token: "tok_abc123",
    api_key: "gt_sk_deadbeef",
    authorization: "Bearer xyz",
    client_secret: "s3cret",
    password: "hunter2",
  });
  for (const key of ["confirm_token", "api_key", "authorization", "client_secret", "password"]) {
    assertEquals(out[key], { type: "redacted" }, `${key} was not fully redacted`);
  }
  const serialized = JSON.stringify(out);
  for (const secret of ["tok_abc123", "gt_sk_deadbeef", "Bearer xyz", "s3cret", "hunter2"]) {
    assert(!serialized.includes(secret), `a secret value survived: ${secret}`);
  }
  // And no length leaked either.
  assert(!serialized.includes("length"));
});

Deno.test("numbers and booleans are kept: they are small and often the point", () => {
  const out = redactArguments({ limit: 25, min_watchers: 3, listed: true });
  assertEquals(out.limit, 25);
  assertEquals(out.min_watchers, 3);
  assertEquals(out.listed, true);
});

Deno.test("protocol _meta is not a tool argument and is not stored", () => {
  const out = redactArguments({
    item_id: "abc",
    _meta: { "io.modelcontextprotocol/clientInfo": { name: "Claude" } },
  });
  assertEquals(out._meta, undefined);
});

Deno.test("an id-shaped key with an absurdly long value is summarised, not kept", () => {
  // Otherwise "item_id" becomes an unbounded write path into the audit table.
  const out = redactArguments({ item_id: "x".repeat(5000) });
  assertEquals(out.item_id, { type: "string", length: 5000 });
});

Deno.test("a caller cannot bloat the row with hundreds of keys", () => {
  const args: Record<string, unknown> = {};
  for (let i = 0; i < 200; i++) args[`k${i}`] = i;
  const out = redactArguments(args);
  assert(Object.keys(out).length <= 21, "the key cap did not apply");
  assertEquals(out._truncated, true);
});

Deno.test("null and undefined survive as null rather than disappearing", () => {
  const out = redactArguments({ cursor: null, brand: undefined });
  assertEquals(out.cursor, null);
  assertEquals(out.brand, null);
});

Deno.test("redactArguments tolerates a missing argument object", () => {
  assertEquals(redactArguments({}), {});
});

// ---------------------------------------------------------------------------
// US-9117: the money exception to "an array is a count"
//
// A reprice is asked for as an array of {listing_id, price_cents}. Summarising
// that as {"type":"array","length":12} throws away the entire answer to "which
// listings, and to what", which is the one question a pricing dispute asks. So
// an array whose elements are ONLY ids and named numbers is kept, and anything
// with a free-text field in it still collapses.
// ---------------------------------------------------------------------------

Deno.test("an array of listing ids and prices is kept, because it IS the row", () => {
  const out = redactArguments({
    items: [
      { listing_id: "l-1", price_cents: 4200 },
      { listing_id: "l-2", price_cents: 1899 },
    ],
  });
  assertEquals(out.items, {
    type: "array",
    length: 2,
    items: [
      { listing_id: "l-1", price_cents: 4200 },
      { listing_id: "l-2", price_cents: 1899 },
    ],
  });
});

Deno.test("one free-text field and the whole array goes back to being a count", () => {
  const out = redactArguments({
    items: [
      { listing_id: "l-1", price_cents: 4200 },
      { listing_id: "l-2", price_cents: 1899, note: "buyer said it smells of smoke" },
    ],
  });
  assertEquals(out.items, { type: "array", length: 2 });
  assert(!JSON.stringify(out).includes("smoke"), "free text reached the audit row");
});

Deno.test("a bare string array is still a count, not its contents", () => {
  const out = redactArguments({ reasons: ["stale", "undercut", "seasonal"] });
  assertEquals(out.reasons, { type: "array", length: 3 });
});

Deno.test("an unnamed number in an element does not buy the element in", () => {
  // `weight` is not money, a count or a quantity, so it is not on the list and
  // the element is refused. The list is an allowlist on purpose.
  const out = redactArguments({ items: [{ listing_id: "l-1", weight: 3 }] });
  assertEquals(out.items, { type: "array", length: 1 });
});

Deno.test("a huge array is capped and SAYS it was capped", () => {
  const items = Array.from({ length: 120 }, (_, i) => ({
    listing_id: `l-${i}`,
    price_cents: 1000 + i,
  }));
  const out = redactArguments({ items }) as {
    items: { length: number; items: unknown[]; items_truncated?: boolean };
  };
  assertEquals(out.items.length, 120);
  assertEquals(out.items.items.length, 50);
  assertEquals(out.items.items_truncated, true);
});

Deno.test("a credential-shaped key inside an element disqualifies the element", () => {
  const out = redactArguments({
    items: [{ listing_id: "l-1", price_cents: 100, api_key: "sk-live-abc" }],
  });
  assertEquals(out.items, { type: "array", length: 1 });
  assert(!JSON.stringify(out).includes("sk-live"), "a credential reached the audit row");
});

Deno.test("handler-supplied _detail is recursed into, so its prices survive", () => {
  const out = redactArguments({
    confirm_token: "ct_secret",
    _detail: {
      changes: [
        { listing_id: "l-1", from_price_cents: 5000, to_price_cents: 4200, changed: true },
      ],
    },
  }) as { _detail: { changes: { items: unknown[] } }; confirm_token: unknown };

  assertEquals(out._detail.changes.items, [
    { listing_id: "l-1", from_price_cents: 5000, to_price_cents: 4200, changed: true },
  ]);
  // The token is still dropped: being inside a detail block buys nothing.
  assertEquals(out.confirm_token, { type: "redacted" });
});

Deno.test("an ordinary nested object is still a key count, not a copy", () => {
  const out = redactArguments({
    _detail: { filters: { brand: "Carhartt", size: "L" } },
  }) as { _detail: { filters: unknown } };
  assertEquals(out._detail.filters, { type: "object", keys: 2 });
});
