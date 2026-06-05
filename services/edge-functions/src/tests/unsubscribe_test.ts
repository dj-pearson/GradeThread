// US-516: no-login unsubscribe token sign/verify (CAN-SPAM).
import { assert, assertEquals } from "@std/assert";
import { unsubscribeToken, verifyUnsubscribeToken } from "../lib/unsubscribe.ts";

Deno.test("a token verifies for its own user id", async () => {
  const t = await unsubscribeToken("user-123");
  assert(await verifyUnsubscribeToken("user-123", t));
});

Deno.test("a token does NOT verify for a different user id", async () => {
  const t = await unsubscribeToken("user-123");
  assertEquals(await verifyUnsubscribeToken("user-456", t), false);
});

Deno.test("a tampered token is rejected", async () => {
  const t = await unsubscribeToken("user-123");
  const tampered = t.slice(0, -1) + (t.endsWith("0") ? "1" : "0");
  assertEquals(await verifyUnsubscribeToken("user-123", tampered), false);
});

Deno.test("an empty/short token is rejected (no length leak)", async () => {
  assertEquals(await verifyUnsubscribeToken("user-123", ""), false);
  assertEquals(await verifyUnsubscribeToken("user-123", "abc"), false);
});
