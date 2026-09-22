// ebay-trading reaches env-at-import through ebay-client (US-2379), so the test
// env has to load before that graph does.
import "./_env.ts";
import { assertEquals, assertThrows } from "@std/assert";
import { parseMemberMessages } from "../lib/ebay-trading.ts";

// US-3464. The buyer-message inbox was empty for every seller from the day it
// shipped (US-673). The parser forced MemberMessage, the single container, to
// an array, so the code read `.MemberMessageExchange` off `[{...}]` and got
// undefined. No recorded response had ever been run through it.

function exchange(id: string, status: string, sender = "buyer_one"): string {
  return `
    <MemberMessageExchange>
      <Item><ItemID>110000000001</ItemID></Item>
      <Question>
        <MessageType>AskSellerQuestion</MessageType>
        <SenderID>${sender}</SenderID>
        <Subject>Question about the jacket</Subject>
        <Body>Is the zipper original?</Body>
        <MessageID>${id}</MessageID>
        <ItemID>110000000001</ItemID>
        <CreationDate>2026-09-20T15:00:00.000Z</CreationDate>
      </Question>
      <MessageStatus>${status}</MessageStatus>
    </MemberMessageExchange>`;
}

function response(...exchanges: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <MemberMessage>${exchanges.join("")}
  </MemberMessage>
</GetMemberMessagesResponse>`;
}

Deno.test("US-3464: a single buyer message is read, not dropped", () => {
  const out = parseMemberMessages(response(exchange("MSG-1", "Unanswered")));
  assertEquals(out, [{
    messageId: "MSG-1",
    itemId: "110000000001",
    senderUsername: "buyer_one",
    subject: "Question about the jacket",
    body: "Is the zipper original?",
    creationDate: "2026-09-20T15:00:00.000Z",
    answered: false,
  }]);
});

Deno.test("US-3464: several messages all come through with their answered state", () => {
  const out = parseMemberMessages(
    response(
      exchange("MSG-1", "Unanswered"),
      exchange("MSG-2", "Answered", "buyer_two"),
    ),
  );
  assertEquals(out.map((m) => [m.messageId, m.senderUsername, m.answered]), [
    ["MSG-1", "buyer_one", false],
    ["MSG-2", "buyer_two", true],
  ]);
});

Deno.test("US-3464: an empty inbox is an empty list", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
</GetMemberMessagesResponse>`;
  assertEquals(parseMemberMessages(xml), []);
});

Deno.test("US-3464: an eBay Failure throws with eBay's own message", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMemberMessagesResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors><LongMessage>Invalid date range.</LongMessage></Errors>
</GetMemberMessagesResponse>`;
  assertThrows(() => parseMemberMessages(xml), Error, "Invalid date range.");
});
