// US-2379: ebay-trading reaches env-at-import through ebay-client, so the test
// env has to be in place before that graph loads. The guard in
// test-env-isolation_test.ts fails without this line, and it caught this file.
import "./_env.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { parseBestOffers } from "../lib/ebay-trading.ts";

// US-2816. The owner sent an offer on someone else's eBay listing and
// GradeThread emailed them "You have a new offer — pearsonperform sent an offer
// of $12.00", then showed it with Accept / Counter / Decline. pearsonperform is
// their own handle.
//
// GetBestOffers, called without an ItemID, returns offers this account SENT
// alongside the ones it received, and the response carries NO direction field.
// Every row was mapped straight to an inbound offer.
//
// This file exists because there was no fixture at all for this parser — the
// thing that decides who sent an offer, on a path that emails people, had never
// been run against a recorded response. That absence is why the bug could not
// be diagnosed by reading the repo.

const OWN = "pearsonperform";

/** Shaped like a real GetBestOffers reply: one received, one we sent. */
function response(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetBestOffersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <ItemBestOffersArray>
    <ItemBestOffers>
      <Item><ItemID>110000000001</ItemID><Title>Levis 501 Made in USA W34</Title></Item>
      <BestOfferArray>
        <BestOffer>
          <BestOfferID>OFFER-INBOUND-1</BestOfferID>
          <Buyer><UserID>some_buyer_99</UserID></Buyer>
          <Price currencyID="USD">42.00</Price>
          <Quantity>1</Quantity>
          <Status>Active</Status>
          <BuyerMessage>Would you take 42?</BuyerMessage>
          <ExpirationTime>2026-08-24T17:00:00.000Z</ExpirationTime>
        </BestOffer>
      </BestOfferArray>
    </ItemBestOffers>
    <ItemBestOffers>
      <Item><ItemID>110000000002</ItemID><Title>Vintage Hermes Paris Mens Silk Necktie</Title></Item>
      <BestOfferArray>
        <BestOffer>
          <BestOfferID>OFFER-WE-SENT-1</BestOfferID>
          <Buyer><UserID>${OWN}</UserID></Buyer>
          <Price currencyID="USD">12.00</Price>
          <Quantity>1</Quantity>
          <Status>Active</Status>
          <ExpirationTime>2026-08-24T17:00:00.000Z</ExpirationTime>
        </BestOffer>
      </BestOfferArray>
    </ItemBestOffers>
  </ItemBestOffersArray>
</GetBestOffersResponse>`;
}

Deno.test("an offer this account SENT is not returned as one received", () => {
  const offers = parseBestOffers(response(), OWN);
  assertEquals(offers.length, 1);
  assertEquals(offers[0].bestOfferId, "OFFER-INBOUND-1");
  assertEquals(offers[0].buyerUsername, "some_buyer_99");
});

Deno.test("the received offer keeps every field the notification reads", () => {
  // The email names the buyer, the amount, the item and the deadline. A filter
  // that silently dropped one of those would turn a wrong email into a vague
  // one rather than into a right one.
  const [o] = parseBestOffers(response(), OWN);
  assertEquals(o.itemId, "110000000001");
  assertEquals(o.itemTitle, "Levis 501 Made in USA W34");
  assertEquals(o.price, 42);
  assertEquals(o.currency, "USD");
  assertEquals(o.quantity, 1);
  assertEquals(o.status, "Active");
  assertEquals(o.message, "Would you take 42?");
  assertEquals(o.expiresAt, "2026-08-24T17:00:00.000Z");
});

Deno.test("eBay usernames compare case-insensitively, on BOTH sides", () => {
  // eBay usernames are not case-sensitive, and neither side is trustworthy:
  // the handle stored at connect time and the casing eBay returns can each
  // differ from the other.
  //
  // BOTH directions are asserted because only one of them was, and a sabotage
  // proved it: dropping .toLowerCase() from the BUYER side left this green,
  // since the fixture happened to spell the buyer in lower case already. A
  // guard that only varies one side tests the normalisation it already did.
  assertEquals(parseBestOffers(response(), "PearsonPerform").length, 1);
  assertEquals(parseBestOffers(response(), "  PEARSONPERFORM  ").length, 1);

  const mixed = response().replace(`<UserID>${OWN}</UserID>`, "<UserID>PearsonPerform</UserID>");
  assertEquals(parseBestOffers(mixed, OWN).length, 1, "buyer casing from eBay ignored");
  assertEquals(parseBestOffers(mixed, "PEARSONPERFORM").length, 1);
});

Deno.test("a seller COUNTERING our own offer is still ours, not an inbound one", () => {
  // Owner-reported the day this shipped: they made an offer as a BUYER, the
  // seller countered, and the counter arrived as a received-offer email.
  //
  // The counter continues the same Best Offer thread, so the Buyer on the
  // record is still us. The filter keys on WHO THE BUYER IS rather than on
  // Status, which is why it covers this without a second rule - and this case
  // exists so that stays true if anyone ever reaches for a status check.
  // Both statuses flip: the assertion is about WHO, not about status, and a
  // fixture where only one changed would leave that ambiguous.
  const countered = response().replaceAll(
    "<Status>Active</Status>",
    "<Status>Countered</Status>",
  );
  const offers = parseBestOffers(countered, OWN);
  // Only the genuinely inbound one survives, whatever its status.
  assertEquals(offers.length, 1);
  assertEquals(offers[0].buyerUsername, "some_buyer_99");
});

Deno.test("an UNKNOWN own handle filters NOTHING, rather than everything", () => {
  // The safe direction, and the whole reason the filter is written this way.
  // account_handle is nullable, so "cannot tell" is a real state — and dropping
  // on a comparison against null would hide every genuine offer in silence,
  // which is far worse than the bug being fixed.
  assertEquals(parseBestOffers(response(), null).length, 2);
  assertEquals(parseBestOffers(response(), "").length, 2);
  assertEquals(parseBestOffers(response(), "   ").length, 2);
});

Deno.test("a different seller's handle does not suppress a real buyer", () => {
  // Guards the mistake that would look like a fix: matching on anything other
  // than this account's own handle.
  assertEquals(parseBestOffers(response(), "someone_else").length, 2);
});

Deno.test("an offer with no BestOfferID is skipped, sent or not", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetBestOffersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <ItemBestOffersArray>
    <ItemBestOffers>
      <Item><ItemID>1</ItemID><Title>t</Title></Item>
      <BestOfferArray>
        <BestOffer><Buyer><UserID>b</UserID></Buyer><Status>Active</Status></BestOffer>
      </BestOfferArray>
    </ItemBestOffers>
  </ItemBestOffersArray>
</GetBestOffersResponse>`;
  assertEquals(parseBestOffers(xml, OWN).length, 0);
});

Deno.test("an empty response is empty, not an error", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetBestOffersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
</GetBestOffersResponse>`;
  assertEquals(parseBestOffers(xml, OWN).length, 0);
});

Deno.test("an eBay Failure still throws, and says why", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetBestOffersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors><LongMessage>Auth token is invalid.</LongMessage></Errors>
</GetBestOffersResponse>`;
  assertThrows(() => parseBestOffers(xml, OWN), Error, "Auth token is invalid.");
});
