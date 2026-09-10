import { describe, expect, it } from "vitest";
import type { EbayBestOffer, EbayBuyerMessage } from "@/hooks/use-ebay";
import {
  DEFAULT_MESSAGE_SORT,
  DEFAULT_OFFER_SORT,
  filterMessages,
  filterOffers,
  isOpenOffer,
  naturalMessageDir,
  naturalOfferDir,
  nextSort,
  offerEconomics,
  sortMessages,
  sortOffers,
} from "@/pages/flipdesk/offers-sort";

const NOW = Date.parse("2026-09-09T12:00:00Z");
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

function offer(over: Partial<EbayBestOffer> & { bestOfferId: string }): EbayBestOffer {
  return {
    itemId: `item-${over.bestOfferId}`,
    itemTitle: "Levi's 501",
    buyerUsername: "buyer1",
    price: 40,
    currency: "USD",
    listPriceCents: 5000,
    itemCost: 12,
    ...over,
  };
}

function message(
  over: Partial<EbayBuyerMessage> & { messageId: string },
): EbayBuyerMessage {
  return {
    itemId: "item-1",
    senderUsername: "buyer1",
    subject: "Does this fit?",
    body: "What is the waist measurement?",
    creationDate: inHours(-2),
    answered: false,
    ...over,
  };
}

const ids = (list: { bestOfferId: string }[]) => list.map((o) => o.bestOfferId);

describe("offer sorting (US-3297)", () => {
  it("defaults to soonest-expiring first, which is the reason the table exists", () => {
    expect(DEFAULT_OFFER_SORT).toEqual({ field: "expires", dir: "asc" });
    const rows = sortOffers(
      [
        offer({ bestOfferId: "b", expiresAt: inHours(40) }),
        offer({ bestOfferId: "a", expiresAt: inHours(3) }),
        offer({ bestOfferId: "c", expiresAt: inHours(20) }),
      ],
      DEFAULT_OFFER_SORT,
    );
    expect(ids(rows)).toEqual(["a", "c", "b"]);
  });

  it("sends an unknown value to the bottom whichever way the column points", () => {
    // The failure this pins: nulls treated as zero. Sorted ascending by expiry
    // that puts every dateless offer above the one dying in an hour; sorted by
    // net it puts every unknown-cost offer where the losses go.
    const rows = [
      offer({ bestOfferId: "known", expiresAt: inHours(5) }),
      offer({ bestOfferId: "none", expiresAt: null }),
      offer({ bestOfferId: "junk", expiresAt: "not a date" }),
    ];
    expect(ids(sortOffers(rows, { field: "expires", dir: "asc" }))[0]).toBe("known");
    expect(ids(sortOffers(rows, { field: "expires", dir: "desc" }))[0]).toBe("known");
    for (const dir of ["asc", "desc"] as const) {
      expect(ids(sortOffers(rows, { field: "expires", dir })).slice(1).sort()).toEqual([
        "junk",
        "none",
      ]);
    }
  });

  it("sorts by net using the same figure the row renders", () => {
    // Both cost $12 and both are offered $40, but one carries $8.30 of postage
    // and a $6 grading fee. Sorting on the offer price alone would call them
    // equal; sorting on net puts the expensive one below.
    const rows = sortOffers(
      [
        offer({ bestOfferId: "loaded", shippingCost: 8.3, gradingCost: 6 }),
        offer({ bestOfferId: "bare" }),
      ],
      { field: "net", dir: "desc" },
    );
    expect(ids(rows)).toEqual(["bare", "loaded"]);
  });

  it("sorts by share of asking price, not by the raw offer", () => {
    // $30 on a $40 listing beats $35 on a $100 one, and the seller comparing
    // discount depth wants the second last.
    const rows = sortOffers(
      [
        offer({ bestOfferId: "shallow", price: 35, listPriceCents: 10_000 }),
        offer({ bestOfferId: "deep", price: 30, listPriceCents: 4000 }),
      ],
      { field: "share", dir: "desc" },
    );
    expect(ids(rows)).toEqual(["deep", "shallow"]);
  });

  it("keeps ties in a stable order across the 90-second refetch", () => {
    // Two offers expiring in the same instant must not swap places while the
    // seller is reading them.
    const rows = [
      offer({ bestOfferId: "zz", expiresAt: inHours(6) }),
      offer({ bestOfferId: "aa", expiresAt: inHours(6) }),
    ];
    expect(ids(sortOffers(rows, DEFAULT_OFFER_SORT))).toEqual(["aa", "zz"]);
    expect(ids(sortOffers([...rows].reverse(), DEFAULT_OFFER_SORT))).toEqual([
      "aa",
      "zz",
    ]);
  });

  it("does not mutate the array it was handed", () => {
    const rows = [
      offer({ bestOfferId: "b", expiresAt: inHours(40) }),
      offer({ bestOfferId: "a", expiresAt: inHours(3) }),
    ];
    sortOffers(rows, DEFAULT_OFFER_SORT);
    expect(ids(rows)).toEqual(["b", "a"]);
  });
});

describe("nextSort", () => {
  it("points a new column at its natural direction", () => {
    // Money and deadlines have an obvious first click; alphabetical does not.
    expect(naturalOfferDir("expires")).toBe("asc");
    expect(naturalOfferDir("item")).toBe("asc");
    expect(naturalOfferDir("net")).toBe("desc");
    expect(naturalMessageDir("buyer")).toBe("asc");
    expect(naturalMessageDir("received")).toBe("desc");

    expect(nextSort(DEFAULT_OFFER_SORT, "net", naturalOfferDir("net"))).toEqual({
      field: "net",
      dir: "desc",
    });
  });

  it("flips a column that is already sorted", () => {
    expect(nextSort({ field: "net", dir: "desc" }, "net", "desc")).toEqual({
      field: "net",
      dir: "asc",
    });
    expect(nextSort({ field: "net", dir: "asc" }, "net", "desc")).toEqual({
      field: "net",
      dir: "desc",
    });
  });
});

describe("isOpenOffer", () => {
  it("counts an offer that is still live", () => {
    expect(isOpenOffer(offer({ bestOfferId: "a", status: "ACTIVE", expiresAt: inHours(5) }), NOW)).toBe(true);
    expect(isOpenOffer(offer({ bestOfferId: "b", status: null, expiresAt: null }), NOW)).toBe(true);
  });

  it("drops one eBay has already closed, whatever the casing", () => {
    for (const status of ["ACCEPTED", "declined", "Expired", "RETRACTED"]) {
      expect(isOpenOffer(offer({ bestOfferId: "x", status }), NOW)).toBe(false);
    }
  });

  it("drops one whose clock ran out even while eBay still says ACTIVE", () => {
    // The failure this pins: eBay's status lags its own expiry, and the offers
    // query only refreshes every 90 seconds. Counting a dead offer puts a badge
    // on a tab for work that no longer exists.
    expect(
      isOpenOffer(
        offer({ bestOfferId: "stale", status: "ACTIVE", expiresAt: inHours(-1) }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("filtering", () => {
  const rows = [
    offer({ bestOfferId: "a", itemTitle: "Levi's 501 Jeans", buyerUsername: "denimfan" }),
    offer({ bestOfferId: "b", itemTitle: "Nike Windbreaker", buyerUsername: "swoosh22" }),
    offer({ bestOfferId: "c", itemTitle: null, buyerUsername: null, message: "Any chance on shipping?" }),
  ];

  it("matches item, buyer and the buyer's note, case-insensitively", () => {
    expect(ids(filterOffers(rows, "levi"))).toEqual(["a"]);
    expect(ids(filterOffers(rows, "SWOOSH"))).toEqual(["b"]);
    expect(ids(filterOffers(rows, "shipping"))).toEqual(["c"]);
  });

  it("returns everything for an empty or whitespace query", () => {
    expect(ids(filterOffers(rows, ""))).toEqual(["a", "b", "c"]);
    expect(ids(filterOffers(rows, "   "))).toEqual(["a", "b", "c"]);
  });

  it("survives rows where every searchable field is missing", () => {
    expect(filterOffers(rows, "levi").length).toBe(1);
  });

  it("filters messages over sender, subject and body", () => {
    const msgs = [
      message({ messageId: "m1", senderUsername: "denimfan" }),
      message({ messageId: "m2", subject: "Combined postage", body: null }),
    ];
    expect(filterMessages(msgs, "denim").map((m) => m.messageId)).toEqual(["m1"]);
    expect(filterMessages(msgs, "postage").map((m) => m.messageId)).toEqual(["m2"]);
  });
});

describe("message sorting", () => {
  it("defaults to newest first", () => {
    expect(DEFAULT_MESSAGE_SORT).toEqual({ field: "received", dir: "desc" });
    const rows = sortMessages(
      [
        message({ messageId: "old", creationDate: inHours(-50) }),
        message({ messageId: "new", creationDate: inHours(-1) }),
      ],
      DEFAULT_MESSAGE_SORT,
    );
    expect(rows.map((m) => m.messageId)).toEqual(["new", "old"]);
  });

  it("puts the unanswered on top when sorting by status", () => {
    // Descending is the natural direction for this column, and unanswered is
    // the high value, so one click surfaces the work.
    const rows = sortMessages(
      [
        message({ messageId: "done", answered: true }),
        message({ messageId: "waiting", answered: false }),
      ],
      { field: "status", dir: "desc" },
    );
    expect(rows.map((m) => m.messageId)).toEqual(["waiting", "done"]);
  });

  it("sends a message with no date to the bottom either way", () => {
    const rows = [
      message({ messageId: "dated", creationDate: inHours(-4) }),
      message({ messageId: "undated", creationDate: null }),
    ];
    for (const dir of ["asc", "desc"] as const) {
      expect(sortMessages(rows, { field: "received", dir })[0]!.messageId).toBe(
        "dated",
      );
    }
  });
});

describe("offerEconomics", () => {
  it("turns the offer's cent-denominated list price into the dollars the maths wants", () => {
    // The failure this pins: passing 5000 (cents) where the function expects
    // 50 (dollars) makes every offer read as 0.8% of asking.
    expect(offerEconomics(offer({ bestOfferId: "a" })).listPrice).toBe(50);
    expect(
      offerEconomics(offer({ bestOfferId: "b", listPriceCents: null })).listPrice,
    ).toBeNull();
  });

  it("carries every cost line through, so a new one is added in one place", () => {
    const e = offerEconomics(
      offer({ bestOfferId: "a", shippingCost: 8.3, gradingCost: 6 }),
    );
    expect(e).toMatchObject({
      offerPrice: 40,
      itemCost: 12,
      shippingCost: 8.3,
      gradingCost: 6,
    });
  });
});
