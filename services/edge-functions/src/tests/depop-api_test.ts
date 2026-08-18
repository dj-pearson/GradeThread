// US-714: pure helpers of the Depop listing/order client — the product-upsert
// payload builder, order parsing + refund classification, the net-payout
// estimate, the product-result parser, and the webhook HMAC verifier. These are
// the bits that MUST be correct before any product or order ever flows; the
// DB-touching ingest is covered by depop-orders against a live sandbox.
//
// depop-api.ts imports circuit-breaker (which reads no env at import), so no
// dummy-env preamble is needed — but keep imports static + pure.

import { assert, assertEquals } from "@std/assert";
import {
  buildDepopProductPayload,
  depopRefundStatus,
  estimateDepopNet,
  parseDepopOrder,
  parseProductResult,
  depopTimestampFresh,
  verifyDepopWebhook,
} from "../lib/depop-api.ts";

// ── Product payload ───────────────────────────────────────────────────

Deno.test("buildDepopProductPayload formats price + omits empty optionals", () => {
  const body = buildDepopProductPayload({
    sku: "GT-1",
    description: "Vintage Carhartt jacket",
    price: 59.5,
  });
  assertEquals(body.description, "Vintage Carhartt jacket");
  assertEquals(body.price, { amount: 59.5, currency: "USD" });
  assertEquals(body.quantity, 1);
  // No condition/brand/size/colour/tags/pictures when not supplied.
  assert(!("condition" in body));
  assert(!("brand" in body));
  assert(!("pictures" in body));
});

Deno.test("buildDepopProductPayload carries structured fields + caps tags/pics", () => {
  const body = buildDepopProductPayload({
    sku: "GT-2",
    description: "tee",
    price: 20,
    currency: "GBP",
    condition: "Used - excellent",
    categoryId: "cat-123",
    brand: "Nike",
    size: "M",
    colour: "Black",
    tags: ["#vintage", "y2k", "streetwear", "grunge", "retro", "extra-6th"],
    pictureUrls: Array.from({ length: 10 }, (_, i) => `https://img/${i}.jpg`),
    quantity: 1,
  });
  assertEquals((body.price as { currency: string }).currency, "GBP");
  assertEquals(body.condition, "Used - excellent");
  assertEquals(body.category_id, "cat-123");
  assertEquals(body.brand, "Nike");
  // '#' stripped, capped at 5.
  assertEquals(body.tags, ["vintage", "y2k", "streetwear", "grunge", "retro"]);
  // Pictures capped at 8.
  assertEquals((body.pictures as unknown[]).length, 8);
});

// ── Product result parsing ────────────────────────────────────────────

Deno.test("parseProductResult tolerates id/slug variants and falls back to SKU", () => {
  assertEquals(parseProductResult({ id: "abc" }, "GT-1").productId, "abc");
  assertEquals(parseProductResult({ slug: "xyz" }, "GT-1").productId, "xyz");
  // No id field → falls back to the SKU + a derived url.
  const r = parseProductResult({}, "GT-9");
  assertEquals(r.productId, "GT-9");
  assert(r.listingUrl?.includes("GT-9"));
});

// ── Order parsing ─────────────────────────────────────────────────────

Deno.test("parseDepopOrder normalizes ids, items, parcels", () => {
  const order = parseDepopOrder({
    purchase_id: "P-100",
    order_id: "O-1",
    status: "paid",
    total: { amount: 60, currency: "USD" },
    buyer: { username: "buyer1" },
    created_at: "2026-06-13T10:00:00Z",
    parcels: [{ parcel_id: "PCL-1", shipped: false }],
    items: [{ sku: "GT-1", quantity: 1, price: { amount: 60 } }],
  });
  assert(order);
  assertEquals(order!.purchaseId, "P-100");
  assertEquals(order!.total, 60);
  assertEquals(order!.buyerUsername, "buyer1");
  assertEquals(order!.parcels[0]?.parcelId, "PCL-1");
  assertEquals(order!.lineItems[0]?.sku, "GT-1");
});

Deno.test("parseDepopOrder returns null without a purchase id", () => {
  assertEquals(parseDepopOrder({ status: "paid" }), null);
});

Deno.test("depopRefundStatus maps cancel/refund, else null", () => {
  const base = parseDepopOrder({ purchase_id: "P", items: [{ sku: "s", price: 1 }] })!;
  assertEquals(depopRefundStatus({ ...base, status: "cancelled" }), "cancelled");
  assertEquals(depopRefundStatus({ ...base, status: "refunded" }), "refunded");
  assertEquals(depopRefundStatus({ ...base, status: "paid" }), null);
});

// ── Fee estimate ──────────────────────────────────────────────────────

Deno.test("estimateDepopNet subtracts processing fee and never goes negative", () => {
  // 60 - (60*0.033 + 0.45) = 60 - 2.43 = 57.57
  assertEquals(estimateDepopNet(60), 57.57);
  assertEquals(estimateDepopNet(0), 0);
});

// ── Webhook HMAC ──────────────────────────────────────────────────────

Deno.test("US-2326: the signature covers `<timestamp>.<body>`, not the body alone", async () => {
  // Depop's own "Validate webhooks" guide: the signature is HMAC-SHA256 over
  // "the timestamp and body of the request, separated by a dot". This code used
  // to sign the raw body, which would have rejected every genuine delivery as a
  // mismatch — a bug that never fired only because the connector is gated off.
  const prev = Deno.env.get("DEPOP_WEBHOOK_SECRET");
  try {
    Deno.env.set("DEPOP_WEBHOOK_SECRET", "shhh");
    const raw = '{"order":{"purchase_id":"P-1"}}';
    const ts = "1760000000";
    const sign = async (msg: string) => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("shhh"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const mac = new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)),
      );
      const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
      let bin = "";
      for (const b of mac) bin += String.fromCharCode(b);
      return { hex, b64: btoa(bin) };
    };

    const good = await sign(`${ts}.${raw}`);
    assert(await verifyDepopWebhook(raw, good.hex, ts), "hex sig should verify");
    assert(await verifyDepopWebhook(raw, `sha256=${good.hex}`, ts), "prefixed hex should verify");
    assert(await verifyDepopWebhook(raw, good.b64, ts), "base64 sig should verify");

    // THE REGRESSION THIS FILE EXISTED TO MISS: a body-only HMAC is exactly what
    // the old implementation produced, and it must now be refused.
    const bodyOnly = await sign(raw);
    assert(
      !(await verifyDepopWebhook(raw, bodyOnly.hex, ts)),
      "a body-only signature is the OLD contract and must not verify",
    );

    // A signature bound to one timestamp cannot be replayed under another.
    assert(
      !(await verifyDepopWebhook(raw, good.hex, "1760000001")),
      "the timestamp is signed, so a different one must not verify",
    );
    assert(!(await verifyDepopWebhook(raw, good.hex, "")), "no timestamp, nothing to verify");
    assert(!(await verifyDepopWebhook(raw, "deadbeef", ts)), "wrong sig rejected");
    assert(!(await verifyDepopWebhook("tampered", good.hex, ts)), "tampered body rejected");
  } finally {
    if (prev != null) Deno.env.set("DEPOP_WEBHOOK_SECRET", prev);
    else Deno.env.delete("DEPOP_WEBHOOK_SECRET");
  }
});

Deno.test("US-2326: the freshness window refuses a stale OR a future timestamp", () => {
  const now = 1_760_000_000_000; // ms
  const sec = (msOffset: number) => String((now + msOffset) / 1000);
  assert(depopTimestampFresh(sec(0), now), "now is fresh");
  assert(depopTimestampFresh(sec(-4 * 60_000), now), "four minutes old is fresh");
  assert(!depopTimestampFresh(sec(-6 * 60_000), now), "six minutes old is stale");
  // Symmetric on purpose: a FUTURE timestamp is as much a sign of a forged or
  // skewed sender as an old one, and accepting it leaves the window open from
  // the other side.
  assert(!depopTimestampFresh(sec(6 * 60_000), now), "six minutes ahead is refused");

  // Milliseconds are distinguished from seconds by magnitude, so a sender that
  // switches units does not silently fall outside every window.
  assert(depopTimestampFresh(String(now), now), "a millisecond timestamp is understood");

  assert(!depopTimestampFresh("", now), "empty is not a timestamp");
  assert(!depopTimestampFresh("not-a-number", now), "garbage is not a timestamp");
  assert(!depopTimestampFresh("   ", now), "whitespace is not a timestamp");
});

Deno.test("verifyDepopWebhook returns false when no secret is configured", async () => {
  const prev = Deno.env.get("DEPOP_WEBHOOK_SECRET");
  try {
    Deno.env.delete("DEPOP_WEBHOOK_SECRET");
    assert(!(await verifyDepopWebhook("{}", "anything", "1760000000")));
  } finally {
    if (prev != null) Deno.env.set("DEPOP_WEBHOOK_SECRET", prev);
  }
});
