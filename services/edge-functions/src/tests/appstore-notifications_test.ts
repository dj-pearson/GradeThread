// ASSN V2 notificationType → action routing. Fail closed to "ignore".

import { assertEquals } from "@std/assert";
import { routeNotification } from "../lib/appstore/notifications.ts";

Deno.test("entitling subscription events", () => {
  assertEquals(routeNotification("SUBSCRIBED"), "sub_active");
  assertEquals(routeNotification("DID_RENEW"), "sub_active");
  assertEquals(routeNotification("OFFER_REDEEMED"), "sub_active");
});

Deno.test("renewal-status change depends on subtype", () => {
  assertEquals(
    routeNotification("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_ENABLED"),
    "sub_renew_on",
  );
  assertEquals(
    routeNotification("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED"),
    "sub_renew_off",
  );
  // Missing subtype reads as "won't renew" (fail safe).
  assertEquals(routeNotification("DID_CHANGE_RENEWAL_STATUS"), "sub_renew_off");
});

Deno.test("expiry, revoke, consumable", () => {
  assertEquals(routeNotification("EXPIRED"), "sub_expired");
  assertEquals(routeNotification("GRACE_PERIOD_EXPIRED"), "sub_expired");
  assertEquals(routeNotification("REFUND"), "revoke");
  assertEquals(routeNotification("REVOKE"), "revoke");
  assertEquals(routeNotification("ONE_TIME_CHARGE"), "consumable_grant");
});

Deno.test("unknown notification types fail closed to ignore", () => {
  assertEquals(routeNotification("CONSUMPTION_REQUEST"), "ignore");
  assertEquals(routeNotification("SOME_FUTURE_TYPE"), "ignore");
});
