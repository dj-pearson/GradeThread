// US-1426: the eBay marketplace-account-deletion handler deactivates
// marketplace_connections (nulling OAuth tokens). A failed deactivation UPDATE
// must trigger a retry (release the idempotency claim + non-2xx), NOT a clean
// 204 that leaves the connection + long-lived refresh token alive while eBay
// considers the account deleted. accountDeletionOutcome is the decision point.

import "./_env.ts";
import { assertEquals } from "@std/assert";
import { accountDeletionOutcome } from "../routes/flipdesk-webhooks.ts";

Deno.test("both deactivation updates clean → ack (204)", () => {
  assertEquals(accountDeletionOutcome([null, null]), "ack");
  assertEquals(accountDeletionOutcome([]), "ack"); // nothing matched, nothing errored
});

Deno.test("any deactivation update error → retry (release claim + non-2xx)", () => {
  // id-match update failed, handle-match clean.
  assertEquals(accountDeletionOutcome([{ message: "deadlock" }, null]), "retry");
  // handle-match update failed.
  assertEquals(accountDeletionOutcome([null, { message: "timeout" }]), "retry");
  // both failed.
  assertEquals(
    accountDeletionOutcome([{ message: "a" }, { message: "b" }]),
    "retry",
  );
});
