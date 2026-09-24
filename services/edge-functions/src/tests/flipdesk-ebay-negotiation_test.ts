// OM-01..03 + OM-14: the Offers & Messages routes validate before they call
// eBay, route by the listing's own account, keep raw eBay text out of the
// browser, and audit every binding action.
//
// The validators are pure and run here directly. The route wiring needs a live
// eBay connection and a real Supabase, so it is checked as SOURCE in the style
// of ebay-bulk-revise_test.ts: each guard names the property that regresses.

import "./_env.ts";
import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  MEMBER_MESSAGE_MAX,
  parseCounterQuantity,
  parseDiscountPct,
  parseReplyBody,
  parseSendOfferBody,
  priceToCents,
  SEND_OFFER_MAX_LISTINGS,
  sendGroupsRecordingEach,
  storedOfferClosedReason,
  validateCounter,
} from "../lib/offer-limits.ts";
import { replyFailureDetail } from "../routes/flipdesk-ebay-negotiation.ts";
import { ebayRouteFile } from "./_ebay-routes.ts";

const SRC = Deno.readTextFileSync(ebayRouteFile("flipdesk-ebay-negotiation.ts"))
  .replace(/\r\n/g, "\n");
const TRADING = Deno.readTextFileSync(new URL("../lib/ebay-trading.ts", import.meta.url))
  .replace(/\r\n/g, "\n");

/** One handler's text, bounded by the next route registration. */
function handler(method: "get" | "post", path: string): string {
  const at = SRC.indexOf(`flipdeskEbayRoutes.${method}("${path}"`);
  assert(at > -1, `${method.toUpperCase()} ${path} is gone`);
  const next = SRC.indexOf("flipdeskEbayRoutes.", at + 40);
  return SRC.slice(at, next === -1 ? SRC.length : next);
}

// ── OM-01: reply ────────────────────────────────────────────────────────────

const reply = (text: string, over: Record<string, unknown> = {}) =>
  parseReplyBody("MSG-1", { item_id: "110000000001", recipient_id: "buyer_one", body: text, ...over });

Deno.test("OM-01: a reply at the cap is accepted, one character over is body_too_long", () => {
  assert(reply("a".repeat(MEMBER_MESSAGE_MAX)).ok);
  const over = reply("a".repeat(MEMBER_MESSAGE_MAX + 1));
  assertFalse(over.ok);
  if (!over.ok) {
    assertEquals(over.code, "body_too_long");
    assertEquals(over.max, 2000);
  }
});

Deno.test("OM-01: ids are bounded to what eBay sends", () => {
  assertEquals((reply("hi", { item_id: "1".repeat(65) }) as { code?: string }).code, "invalid_id");
  assertEquals((reply("hi", { recipient_id: "a b" }) as { code?: string }).code, "invalid_id");
  assertEquals(
    (parseReplyBody("<x>", { item_id: "1", recipient_id: "b", body: "hi" }) as { code?: string })
      .code,
    "invalid_id",
  );
  assertEquals((reply("   ") as { code?: string }).code, "missing_fields");
});

Deno.test("OM-01: a raw Trading XML failure never reaches the browser", () => {
  const raw = new Error(
    `eBay AddMemberMessageRTQ failed (500): <?xml version="1.0"?><AddMemberMessageRTQResponse>` +
      `<Ack>Failure</Ack><Errors><LongMessage>Internal</LongMessage></Errors>`,
  );
  const detail = replyFailureDetail(raw);
  assertFalse(detail.includes("<"), detail);
  assertFalse(detail.includes("AddMemberMessageRTQ"), detail);
});

Deno.test("OM-01: the reply goes out under the listing's own connection", () => {
  const body = handler("post", "/messages/:messageId/reply");
  assert(
    /connectionIdsByPlatformListingId\(userId, \[itemId\]\)/.test(body),
    "the reply route no longer resolves the listing's connection (US-1507)",
  );
  assert(
    /replyToMemberMessage\(userId, \{[\s\S]*?\}, connByListing\.get\(itemId\)\)/.test(body),
    "the resolved connection id is not passed to replyToMemberMessage",
  );
  // And the lib forwards it to tradingCall, or the route's lookup is decoration.
  const lib = TRADING.slice(TRADING.indexOf("export async function replyToMemberMessage"));
  assert(
    /tradingCall\(\s*userId,\s*"AddMemberMessageRTQ",\s*xml,\s*connectionId,?\s*\)/.test(
      lib.slice(0, 1500),
    ),
    "replyToMemberMessage drops its connectionId before tradingCall",
  );
});

Deno.test("OM-01: the reply is audited without its text, and String(err) is gone", () => {
  const body = handler("post", "/messages/:messageId/reply");
  assert(/action: "ebay\.message\.reply"/.test(body), "no audit row for a sent reply");
  assert(/length: text\.length/.test(body));
  assertFalse(/details:[^}]*\btext\b(?!\.length)/.test(body), "the audit row carries the reply text");
  assertFalse(/String\(err\)/.test(body), "the raw error is back in the response");
});

// ── OM-02: send-offer ───────────────────────────────────────────────────────

const send = (discount: unknown, ids: unknown = ["111", "222"], message?: unknown) =>
  parseSendOfferBody({ listing_ids: ids, discount_percentage: discount, message });

Deno.test("OM-02: the discount is a whole number from 1 to 60, as a number or a string", () => {
  assertEquals(parseDiscountPct(15), 15, "a numeric 15 used to be dropped");
  assertEquals(parseDiscountPct("15"), 15);
  for (const bad of [0, 61, "12.5", "abc", "", null, 0.4, -5]) {
    assertEquals(parseDiscountPct(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
  assertEquals((send(0) as { code?: string }).code, "discount_out_of_range");
  assertEquals((send(61) as { code?: string }).code, "discount_out_of_range");
  assertEquals((send("12.5") as { code?: string }).code, "discount_out_of_range");
  assertEquals((send("abc") as { code?: string }).code, "discount_out_of_range");
  const ok = send(15);
  assert(ok.ok);
  if (ok.ok) assertEquals(ok.value.discountPct, 15);
});

Deno.test("OM-02: listing ids are de-duplicated and capped", () => {
  const dup = send(10, ["111", "111", "222"]);
  assert(dup.ok);
  if (dup.ok) assertEquals(dup.value.listingIds, ["111", "222"]);
  const many = Array.from({ length: SEND_OFFER_MAX_LISTINGS + 1 }, (_, i) => String(1000 + i));
  assertEquals((send(10, many) as { code?: string }).code, "too_many_listings");
  const exact = Array.from({ length: SEND_OFFER_MAX_LISTINGS }, (_, i) => String(1000 + i));
  assert(send(10, exact).ok);
  assertEquals((send(10, []) as { code?: string }).code, "listing_ids_required");
});

Deno.test("OM-02: the message is trimmed and capped", () => {
  assertEquals((send(10, ["1"], "x".repeat(2001)) as { code?: string }).code, "message_too_long");
  const ok = send(10, ["1"], "  hi  ");
  assert(ok.ok);
  if (ok.ok) assertEquals(ok.value.message, "hi");
});

Deno.test("OM-02: when store 2 throws, store 1's offers are still recorded", async () => {
  const groups = new Map<string | undefined, string[]>([
    ["conn-a", ["111", "112"]],
    ["conn-b", ["221"]],
  ]);
  const recorded: string[][] = [];
  const result = await sendGroupsRecordingEach(
    groups,
    (key) => key === "conn-b" ? Promise.reject(new Error("eBay 500")) : Promise.resolve(),
    (ids) => {
      recorded.push(ids);
      return Promise.resolve();
    },
  );
  assertEquals(result.sent, ["111", "112"]);
  assertEquals(result.failed.map((f) => f.ids), [["221"]]);
  assertEquals(recorded, [["111", "112"]], "only the group that went out is recorded");
});

Deno.test("OM-02: a failed record does not turn a sent group into a failed one", async () => {
  const result = await sendGroupsRecordingEach(
    new Map([["a", ["1"]]]),
    () => Promise.resolve(),
    () => Promise.reject(new Error("db down")),
  );
  assertEquals(result.sent, ["1"]);
  assertEquals(result.failed, []);
});

Deno.test("OM-02: the route reports sent and failed ids, 502 only when nothing went", () => {
  const body = handler("post", "/negotiation/send-offer");
  assert(/parseSendOfferBody\(body\)/.test(body), "the body is no longer validated");
  assert(/sendGroupsRecordingEach\(/.test(body), "groups are no longer recorded as they send");
  assert(/sent: result\.sent/.test(body) && /failed: result\.failed\.map/.test(body));
  assert(/result\.sent\.length === 0[\s\S]{0,900}502/.test(body));
  assert(/action: "ebay\.offer\.send"/.test(body), "no audit row for a send");
  assertFalse(/typeof body\.discount_percentage === "string"/.test(body), "the numeric drop is back");
});

// ── OM-03: respond ──────────────────────────────────────────────────────────

Deno.test("OM-03: a counter must sit above the bid and below the asking price", () => {
  const base = { offerCents: 4000, listCents: 5000 };
  assertEquals(validateCounter({ ...base, counterCents: 4000 }), {
    ok: false,
    reason: "at_or_below_offer",
  });
  assertEquals(validateCounter({ ...base, counterCents: 5000 }), {
    ok: false,
    reason: "at_or_above_list",
  });
  assertEquals(validateCounter({ ...base, counterCents: 4500 }), { ok: true, cents: 4500 });
  // Unknown bounds do not refuse: no stored copy is not evidence of anything.
  assertEquals(
    validateCounter({ offerCents: null, listCents: null, counterCents: 100 }),
    { ok: true, cents: 100 },
  );
  assertEquals(validateCounter({ ...base, counterCents: null }).ok, false);
});

Deno.test("OM-03: 12.345 is sent as 12.35, and the XML writes two places", () => {
  assertEquals(priceToCents("12.345"), 1235);
  assertEquals(priceToCents(12.345), 1235);
  assertEquals(priceToCents(1.005), 101);
  assertEquals(priceToCents(0), null);
  assertEquals(priceToCents("abc"), null);
  assertEquals((1235 / 100).toFixed(2), "12.35");
  assert(
    /<CounterOfferPrice[^`]*counterPrice\.toFixed\(2\)/.test(TRADING),
    "the counter price is written without toFixed(2)",
  );
});

Deno.test("OM-03: counter quantity is a positive whole number, 1 by default", () => {
  assertEquals(parseCounterQuantity(undefined), 1);
  assertEquals(parseCounterQuantity(3), 3);
  assertEquals(parseCounterQuantity("2"), 2);
  for (const bad of [0, -1, 1.5, "x"]) assertEquals(parseCounterQuantity(bad), null);
});

Deno.test("OM-03: a stored expired or closed offer is refused before eBay", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  assertEquals(
    storedOfferClosedReason({ state: "Active", expires_at: "2026-09-24T11:00:00Z" }, now),
    "expired",
  );
  assertEquals(storedOfferClosedReason({ state: "Declined", expires_at: null }, now), "closed");
  assertEquals(
    storedOfferClosedReason({ state: "Active", expires_at: "2026-09-25T11:00:00Z" }, now),
    null,
  );
  assertEquals(storedOfferClosedReason(null, now), null);

  const body = handler("post", "/negotiation/offers/:bestOfferId/respond");
  const refuse = body.indexOf("storedOfferClosedReason(storedRow)");
  const call = body.indexOf("await respondToBestOffer(");
  assert(refuse > -1 && call > refuse, "the stored-state check no longer runs before eBay");
  assert(/code: "offer_not_open" \}, 409/.test(body.slice(refuse, call)));
  assert(/validateCounter\(/.test(body.slice(0, call)), "counter bounds checked after the call");
  // Owner-scoped lookup (US-268).
  assert(/\.from\("marketplace_offers"\)[\s\S]{0,200}\.eq\("user_id", userId\)/.test(body));
});

Deno.test("OM-03: every response is audited with the member who pressed it", () => {
  const body = handler("post", "/negotiation/offers/:bestOfferId/respond");
  assert(/action: "ebay\.offer\.respond"/.test(body));
  assert(/counter_cents: counterCents/.test(body));
  // The audit row is what names the member; writeAuditLog reads
  // c.get("userId"), which is the member, not the workspace owner.
  assert(/await writeAuditLog\(c, \{\s*action: "ebay\.offer\.respond"/.test(body));
});

// ── OM-14: GET /negotiation/offers ──────────────────────────────────────────

Deno.test("OM-14: the offers read runs its lookups together and records off the response path", () => {
  const body = handler("get", "/negotiation/offers");
  assert(/await Promise\.all\(\[/.test(body), "the lookups are serial again");
  assert(
    /void recordOffers\([\s\S]*?\)\.catch\(/.test(body),
    "recordOffers is awaited on the poll again",
  );
  assertFalse(/await recordOffers\(/.test(body));
  assertFalse(
    /loadListPricesByItemId\(/.test(body),
    "the listings rows are read a second time for the price",
  );
  const helper = SRC.slice(SRC.indexOf("async function loadOfferCostRows"));
  assert(/\.eq\("user_id", userId\)/.test(helper.slice(0, 800)));
  assert(/\.eq\("inventory_items\.user_id", userId\)/.test(helper.slice(0, 800)));
});
