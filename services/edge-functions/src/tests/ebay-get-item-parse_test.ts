// US-3468: GetItem's specifics parser, pinned from a fixture so the shape the
// pull writes into inventory_items.ebay_aspects is asserted without an eBay
// token. ebay-trading reaches env-at-import through ebay-client, so the env
// helper goes first (US-2379).
import "./_env.ts";
import { assertEquals } from "@std/assert";
import { parseGetItemDetails } from "../lib/ebay-trading.ts";

const CARD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <Item>
    <ItemID>123456789012</ItemID>
    <PrimaryCategory>
      <CategoryID>261328</CategoryID>
      <CategoryName>Sports Mem, Cards &amp; Fan Shop:Sports Trading Cards:Trading Card Singles</CategoryName>
    </PrimaryCategory>
    <PictureDetails>
      <GalleryURL>https://i.ebayimg.com/images/g/abc/s-l140.jpg</GalleryURL>
      <PictureURL>https://i.ebayimg.com/images/g/abc/s-l1600.jpg</PictureURL>
      <PictureURL>https://i.ebayimg.com/images/g/def/s-l1600.jpg</PictureURL>
    </PictureDetails>
    <ItemSpecifics>
      <NameValueList><Name>Sport</Name><Value>Baseball</Value></NameValueList>
      <NameValueList><Name>Player/Athlete</Name><Value>Ken Griffey Jr.</Value></NameValueList>
      <NameValueList><Name>Season</Name><Value>1989</Value></NameValueList>
      <NameValueList><Name>Set</Name><Value>Upper Deck</Value></NameValueList>
      <NameValueList><Name>Card Number</Name><Value>1</Value></NameValueList>
      <NameValueList><Name>Graded</Name><Value>Yes</Value></NameValueList>
      <NameValueList>
        <Name>Features</Name>
        <Value>Rookie</Value>
        <Value>Hall of Fame</Value>
        <Value>  </Value>
      </NameValueList>
      <NameValueList><Name>Empty</Name><Value></Value></NameValueList>
      <NameValueList><Value>Nameless</Value></NameValueList>
    </ItemSpecifics>
  </Item>
</GetItemResponse>`;

Deno.test("US-3468: GetItem keeps every specific, every value, and the leaf category", () => {
  const parsed = parseGetItemDetails(CARD_XML);
  assertEquals(parsed?.primaryCategoryId, "261328");
  assertEquals(
    parsed?.primaryCategoryPath,
    "Sports Mem, Cards & Fan Shop:Sports Trading Cards:Trading Card Singles",
  );
  assertEquals(parsed?.aspects, {
    Sport: ["Baseball"],
    "Player/Athlete": ["Ken Griffey Jr."],
    Season: ["1989"],
    Set: ["Upper Deck"],
    "Card Number": ["1"],
    Graded: ["Yes"],
    Features: ["Rookie", "Hall of Fame"],
  });
  // The flat map the five columns read takes the FIRST value only, as before.
  assertEquals(parsed?.specifics.Features, "Rookie");
  assertEquals(parsed?.specifics.Sport, "Baseball");
  assertEquals("Empty" in (parsed?.specifics ?? {}), false);
  // Pictures still ride along (US-3196), largest first, gallery thumb folded.
  assertEquals(parsed?.pictureUrls.length, 2);
});

Deno.test("US-3468: a single specific with a single value still parses (not an object)", () => {
  const parsed = parseGetItemDetails(
    `<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item>` +
      `<ItemSpecifics><NameValueList><Name>Brand</Name><Value>Topps</Value></NameValueList></ItemSpecifics>` +
      `</Item></GetItemResponse>`,
  );
  assertEquals(parsed?.aspects, { Brand: ["Topps"] });
  assertEquals(parsed?.specifics, { Brand: "Topps" });
  assertEquals(parsed?.primaryCategoryId, null);
  assertEquals(parsed?.primaryCategoryPath, null);
  assertEquals(parsed?.pictureUrls, []);
});

Deno.test("US-3468: a Failure ack parses to null so the caller returns empties", () => {
  assertEquals(
    parseGetItemDetails(
      `<GetItemResponse><Ack>Failure</Ack><Errors><LongMessage>nope</LongMessage></Errors></GetItemResponse>`,
    ),
    null,
  );
});
