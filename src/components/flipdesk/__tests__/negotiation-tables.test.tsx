// US-3297: first paint of the two negotiation tables.
//
// renderToStaticMarkup is the repo's convention (no @testing-library), so this
// asserts what the seller sees on arrival: that these are real tables with the
// columns the sort logic is written against, that the default order is applied
// before paint rather than after a click, and that the long-form detail is NOT
// in the first render — which is the whole point of the rebuild, and the part
// that silently regresses the moment someone "just shows the message inline".
//
// The eBay hooks are mocked because none of them is what is under test: they
// are thin fetch wrappers, and the ordering they feed is covered as pure
// functions in offers-sort.test.ts. Both breakpoints render into the markup
// (the table is `hidden md:block`, the cards are `md:hidden`), so an assertion
// on text is an assertion about both.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EbayBestOffer, EbayBuyerMessage } from "@/hooks/use-ebay";

const NOW = Date.now();
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

const offersState = {
  data: [] as EbayBestOffer[],
  isLoading: false,
  error: null as Error | null,
  refetch: () => {},
  isFetching: false,
};
const messagesState = {
  data: [] as EbayBuyerMessage[],
  isLoading: false,
  error: null as Error | null,
  refetch: () => {},
  isFetching: false,
};
const idleMutation = { isPending: false, mutateAsync: async () => ({}) };

vi.mock("@/hooks/use-ebay", () => ({
  useEbayBestOffers: () => offersState,
  useEbayMessages: () => messagesState,
  useEbayRespondOffer: () => idleMutation,
  useEbayReplyMessage: () => idleMutation,
  resolveInventoryItemIdForEbayItem: async () => null,
}));
vi.mock("@/hooks/use-ai-extract", () => ({
  useNegotiationDraft: () => idleMutation,
}));

const { BestOffersPanel } = await import(
  "@/components/flipdesk/best-offers-table"
);
const { BuyerMessagesPanel } = await import(
  "@/components/flipdesk/buyer-messages-table"
);

function offer(
  over: Partial<EbayBestOffer> & { bestOfferId: string },
): EbayBestOffer {
  return {
    itemId: `item-${over.bestOfferId}`,
    itemTitle: "Levi's 501",
    buyerUsername: "denimfan",
    price: 40,
    currency: "USD",
    listPriceCents: 5000,
    itemCost: 12,
    expiresAt: inHours(20),
    ...over,
  };
}

function message(
  over: Partial<EbayBuyerMessage> & { messageId: string },
): EbayBuyerMessage {
  return {
    itemId: "item-1",
    senderUsername: "denimfan",
    subject: "Does this fit?",
    body: "What is the waist measurement laid flat?",
    creationDate: inHours(-2),
    answered: false,
    ...over,
  };
}

function paint(node: React.ReactElement): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function offersMarkup(data: EbayBestOffer[], over: Partial<typeof offersState> = {}) {
  Object.assign(offersState, { data, isLoading: false, error: null }, over);
  return paint(<BestOffersPanel />);
}

function messagesMarkup(
  data: EbayBuyerMessage[],
  over: Partial<typeof messagesState> = {},
) {
  Object.assign(messagesState, { data, isLoading: false, error: null }, over);
  return paint(<BuyerMessagesPanel />);
}

describe("Best Offers table (US-3297)", () => {
  it("renders a real table with the columns the sort logic is written against", () => {
    const html = offersMarkup([offer({ bestOfferId: "a" })]);
    expect(html).toContain("<table");
    for (const header of ["Item", "Buyer", "Offer", "% of ask", "Net", "Expires"]) {
      expect(html).toContain(header);
    }
  });

  it("marks the sorted column for a screen reader", () => {
    // The default is soonest-expiring, so Expires is the one carrying it.
    const html = offersMarkup([offer({ bestOfferId: "a" })]);
    expect(html).toContain('aria-sort="ascending"');
  });

  it("paints in expiry order without waiting for a click", () => {
    const html = offersMarkup([
      offer({ bestOfferId: "later", itemTitle: "Nike Windbreaker", expiresAt: inHours(40) }),
      offer({ bestOfferId: "soon", itemTitle: "Carhartt Jacket", expiresAt: inHours(2) }),
    ]);
    expect(html.indexOf("Carhartt Jacket")).toBeLessThan(
      html.indexOf("Nike Windbreaker"),
    );
  });

  it("shows what the offer nets rather than what the buyer pays", () => {
    // $40 offer, $12 cost, $8.30 postage. eBay takes 13.6% + $0.40 = $5.84, so
    // $13.86 lands. The gross figure ($28.00) must not be the headline.
    const html = offersMarkup([
      offer({ bestOfferId: "a", shippingCost: 8.3 }),
    ]);
    expect(html).toContain("$13.86");
  });

  it("says the margin is unknown rather than printing a zero", () => {
    // An item with no recorded cost has an UNKNOWN margin. Rendering that as
    // $0.00 next to an Accept button is a confident lie.
    const html = offersMarkup([offer({ bestOfferId: "a", itemCost: null })]);
    expect(html).toContain("cost unknown");
  });

  it("keeps the buyer's note and the counter form out of the first paint", () => {
    // This is the rebuild in one assertion: the old list printed every note and
    // rendered a counter form per row, which is what made it 140px an offer.
    const html = offersMarkup([
      offer({ bestOfferId: "a", message: "Would you take thirty?" }),
    ]);
    expect(html).not.toContain("Would you take thirty?");
    expect(html).not.toContain("Counter price");
    // The row still says a note exists, so nothing is hidden without a tell.
    expect(html).toContain("This buyer left a note");
  });

  it("offers all three responses on the row", () => {
    const html = offersMarkup([offer({ bestOfferId: "a" })]);
    for (const label of ["Accept", "Counter", "Decline"]) {
      expect(html).toContain(label);
    }
  });

  it("names the marketplace it speaks for when there is nothing to show", () => {
    const html = offersMarkup([]);
    expect(html).toContain("No open offers");
    expect(html).not.toContain("<table");
  });

  it("offers a retry instead of an empty table when the fetch failed", () => {
    const html = offersMarkup([], { error: new Error("eBay timed out") });
    // The apostrophe is HTML-escaped in static markup, so match around it.
    expect(html).toContain("load offers");
    expect(html).toContain("eBay timed out");
    expect(html).toContain("Try again");
  });
});

describe("Buyer messages table (US-3297)", () => {
  it("renders a table with the inbox columns", () => {
    const html = messagesMarkup([message({ messageId: "m1" })]);
    expect(html).toContain("<table");
    for (const header of ["Buyer", "Message", "Received", "Status"]) {
      expect(html).toContain(header);
    }
  });

  it("paints newest first", () => {
    const html = messagesMarkup([
      message({ messageId: "old", senderUsername: "earlybird", creationDate: inHours(-50) }),
      message({ messageId: "new", senderUsername: "latecomer", creationDate: inHours(-1) }),
    ]);
    expect(html.indexOf("latecomer")).toBeLessThan(html.indexOf("earlybird"));
  });

  it("says which messages are still waiting on the seller", () => {
    const html = messagesMarkup([
      message({ messageId: "m1", answered: false }),
      message({ messageId: "m2", answered: true }),
    ]);
    expect(html).toContain("Needs reply");
    expect(html).toContain("Replied");
  });

  it("keeps the reply box out of the first paint", () => {
    const html = messagesMarkup([message({ messageId: "m1" })]);
    expect(html).not.toContain("Your reply");
    expect(html).toContain("Reply");
  });

  it("says coverage is eBay-only when the inbox is empty", () => {
    // "No messages" reads as coverage the page does not have.
    const html = messagesMarkup([]);
    expect(html).toContain("No recent buyer messages");
    expect(html).toContain("not read by GradeThread");
  });
});
