// US-3541: Reseller Swap matching and eBay Partner Network links.
import { assertEquals, assertFalse } from "@std/assert";
import {
  brandKey,
  buildFitProfile,
  clampStaleDays,
  rankTips,
  type SwapCandidate,
} from "../lib/reseller-swap.ts";
import {
  ebayListingUrl,
  EPN_US_ROTATION_ID,
  epnCampaignId,
  withEpnTracking,
} from "../lib/ebay-affiliate.ts";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function candidate(over: Partial<SwapCandidate> = {}): SwapCandidate {
  return {
    itemId: "item-1",
    ownerId: "seller-a",
    ownerStaleDays: 60,
    title: "Patagonia Better Sweater",
    brand: "Patagonia",
    size: "M",
    priceCents: 5900,
    listedAt: daysAgo(90),
    gradeValue: 8.5,
    gradeLabel: "Excellent",
    photoUrl: "https://example.test/p.jpg",
    url: "https://www.ebay.com/itm/123456789012",
    ...over,
  };
}

Deno.test("brandKey folds case, spaces and punctuation", () => {
  assertEquals(brandKey("Levi's"), brandKey("LEVIS"));
  assertEquals(brandKey("The North Face"), "thenorthface");
  assertEquals(brandKey("  "), null);
  assertEquals(brandKey(null), null);
});

Deno.test("fit profile keeps brands sold often and fast, drops the rest", () => {
  const profile = buildFitProfile([
    { brand: "Patagonia", listedAt: daysAgo(20), soldAt: daysAgo(15) },
    { brand: "patagonia", listedAt: daysAgo(40), soldAt: daysAgo(30) },
    { brand: "Zara", listedAt: daysAgo(10), soldAt: daysAgo(9) }, // only one sale
    { brand: "Gap", listedAt: daysAgo(170), soldAt: daysAgo(100) }, // slow
    { brand: "Gap", listedAt: daysAgo(160), soldAt: daysAgo(90) },
    { brand: null, listedAt: null, soldAt: daysAgo(3) },
  ]);
  assertEquals([...profile.keys()], ["patagonia"]);
  assertEquals(profile.get("patagonia")!.sold, 2);
  assertEquals(profile.get("patagonia")!.medianDays, 8);
});

Deno.test("fit profile counts a brand with no listing dates on volume alone", () => {
  const profile = buildFitProfile([
    { brand: "Carhartt", listedAt: null, soldAt: daysAgo(3) },
    { brand: "Carhartt", listedAt: null, soldAt: daysAgo(5) },
  ]);
  assertEquals(profile.get("carhartt")?.medianDays, null);
});

Deno.test("stale days clamp to the DB CHECK range", () => {
  assertEquals(clampStaleDays(3), 14);
  assertEquals(clampStaleDays(900), 365);
  assertEquals(clampStaleDays("x"), 60);
  assertEquals(clampStaleDays(45.4), 45);
});

const PROFILE = buildFitProfile([
  { brand: "Patagonia", listedAt: daysAgo(20), soldAt: daysAgo(15) },
  { brand: "Patagonia", listedAt: daysAgo(40), soldAt: daysAgo(30) },
  { brand: "Patagonia", listedAt: daysAgo(50), soldAt: daysAgo(45) },
  { brand: "Lululemon", listedAt: daysAgo(20), soldAt: daysAgo(18) },
  { brand: "Lululemon", listedAt: daysAgo(30), soldAt: daysAgo(28) },
]);

Deno.test("tips never include the caller's own stock or a dismissed item", () => {
  const tips = rankTips(
    [
      candidate({ itemId: "mine", ownerId: "caller" }),
      candidate({ itemId: "dismissed" }),
      candidate({ itemId: "ok" }),
    ],
    PROFILE,
    {
      excludeOwnerIds: new Set(["caller"]),
      dismissed: new Set(["dismissed"]),
      now: NOW,
    },
  );
  assertEquals(tips.map((t) => t.item_id), ["ok"]);
});

Deno.test("an item is only a tip once it passes its OWNER's stale line", () => {
  const tips = rankTips(
    [
      candidate({ itemId: "fresh", listedAt: daysAgo(30), ownerStaleDays: 60 }),
      candidate({ itemId: "stale", listedAt: daysAgo(30), ownerStaleDays: 21 }),
    ],
    PROFILE,
    { excludeOwnerIds: new Set(), dismissed: new Set(), now: NOW },
  );
  assertEquals(tips.map((t) => t.item_id), ["stale"]);
});

Deno.test("tips skip brands outside the caller's fit and rank by the caller's volume", () => {
  const tips = rankTips(
    [
      candidate({ itemId: "zara", brand: "Zara" }),
      candidate({ itemId: "lulu", brand: "lululemon" }),
      candidate({ itemId: "pata", brand: "PATAGONIA" }),
    ],
    PROFILE,
    { excludeOwnerIds: new Set(), dismissed: new Set(), now: NOW },
  );
  assertEquals(tips.map((t) => t.item_id), ["pata", "lulu"]);
  assertEquals(tips[0].fit.sold, 3);
});

Deno.test("a tip carries no owner id, cost or anything not on the public listing", () => {
  const [tip] = rankTips([candidate()], PROFILE, {
    excludeOwnerIds: new Set(),
    dismissed: new Set(),
    now: NOW,
  });
  const body = JSON.stringify(tip);
  assertFalse(body.includes("seller-a"), "owner id leaked into a tip");
  assertEquals(
    Object.keys(tip).sort(),
    [
      "brand",
      "days_listed",
      "fit",
      "grade_label",
      "grade_value",
      "item_id",
      "photo_url",
      "price_cents",
      "size",
      "title",
      "url",
    ],
  );
});

Deno.test("ebayListingUrl accepts real eBay links and rebuilds from the id", () => {
  assertEquals(
    ebayListingUrl(
      "https://www.ebay.com/itm/Some-Title/123456789012?hash=x",
      null,
    ),
    "https://www.ebay.com/itm/123456789012",
  );
  assertEquals(
    ebayListingUrl(null, "123456789012"),
    "https://www.ebay.com/itm/123456789012",
  );
  assertEquals(
    ebayListingUrl("https://evil.example/itm/123456789012", "123456789012"),
    "https://www.ebay.com/itm/123456789012",
  );
  assertEquals(
    ebayListingUrl("https://www.ebay.com.evil.test/itm/123456789012", null),
    null,
  );
  assertEquals(
    ebayListingUrl("http://www.ebay.com/itm/123456789012", "not-an-id"),
    null,
  );
  assertEquals(ebayListingUrl(null, "v1|123|0"), null);
});

Deno.test("EPN tracking is added only with a valid campaign id", () => {
  const base = "https://www.ebay.com/itm/123456789012";
  assertEquals(withEpnTracking(base, undefined), base);
  assertEquals(withEpnTracking(base, "12345"), base);
  const tracked = new URL(withEpnTracking(base, "5338123456"));
  assertEquals(tracked.searchParams.get("campid"), "5338123456");
  assertEquals(tracked.searchParams.get("mkrid"), EPN_US_ROTATION_ID);
  assertEquals(tracked.searchParams.get("mkevt"), "1");
  assertEquals(tracked.searchParams.get("customid"), "gt-swap");
  assertEquals(tracked.pathname, "/itm/123456789012");
});

Deno.test("EPN tracking is never added to a non-eBay URL", () => {
  const other = "https://example.test/itm/1";
  assertEquals(withEpnTracking(other, "5338123456"), other);
});

Deno.test("epnCampaignId reads only a 10-digit id", () => {
  assertEquals(epnCampaignId(" 5338123456 "), "5338123456");
  assertEquals(epnCampaignId("abc"), undefined);
  assertEquals(epnCampaignId(undefined), undefined);
});
