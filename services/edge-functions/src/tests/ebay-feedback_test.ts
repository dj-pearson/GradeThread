import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildLeaveFeedbackXml,
  isFeedbackAlreadyLeft,
} from "../lib/ebay-trading.ts";

Deno.test("buildLeaveFeedbackXml uses OrderLineItemID when given", () => {
  const xml = buildLeaveFeedbackXml({
    orderLineItemId: "110099-220",
    targetUser: "buyer_bob",
    comment: "Thanks!",
  });
  assertStringIncludes(xml, "<OrderLineItemID>110099-220</OrderLineItemID>");
  assertStringIncludes(xml, "<CommentType>Positive</CommentType>");
  assertStringIncludes(xml, "<TargetUser>buyer_bob</TargetUser>");
});

Deno.test("buildLeaveFeedbackXml falls back to ItemID+TransactionID", () => {
  const xml = buildLeaveFeedbackXml({
    itemId: "11001",
    transactionId: "9999",
    targetUser: "buyer_bob",
    comment: "A+",
  });
  assertStringIncludes(xml, "<ItemID>11001</ItemID>");
  assertStringIncludes(xml, "<TransactionID>9999</TransactionID>");
});

Deno.test("buildLeaveFeedbackXml requires an identifier", () => {
  assertThrows(() =>
    buildLeaveFeedbackXml({ targetUser: "buyer_bob", comment: "hi" })
  );
});

Deno.test("buildLeaveFeedbackXml escapes the comment", () => {
  const xml = buildLeaveFeedbackXml({
    orderLineItemId: "1-2",
    targetUser: "b",
    comment: "great & fast <deal>",
  });
  assertStringIncludes(xml, "great &amp; fast &lt;deal&gt;");
});

Deno.test("isFeedbackAlreadyLeft detects the duplicate case", () => {
  assertEquals(
    isFeedbackAlreadyLeft("Feedback has already been left for this transaction."),
    true,
  );
  assertEquals(isFeedbackAlreadyLeft("Some other error"), false);
});
