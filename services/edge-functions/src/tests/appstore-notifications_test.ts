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

// ── US-2124 AC2: platform-side changes must reach server state ───────
//
// Apple collects price-increase consent natively, so this is not a rejection
// risk — but the server never learned a price change had happened at all. An
// unconsented lapse then arrived as a bare EXPIRED, indistinguishable from an
// ordinary cancellation. Recording the event is what makes that later EXPIRED
// interpretable.

Deno.test("US-2124: PRICE_INCREASE is recorded, not ignored", () => {
  assertEquals(routeNotification("PRICE_INCREASE"), "record_only");
});

Deno.test("US-2124: DID_CHANGE_RENEWAL_PREF is recorded, not ignored", () => {
  assertEquals(routeNotification("DID_CHANGE_RENEWAL_PREF"), "record_only");
});

// The distinction that matters: record_only must NOT move entitlement. Apple
// owns the consent decision; if the customer refuses, Apple lapses the
// subscription and we hear EXPIRED. Acting here would pre-empt that.
Deno.test("US-2124: record_only is not an entitlement action", () => {
  for (const t of ["PRICE_INCREASE", "DID_CHANGE_RENEWAL_PREF"]) {
    const action = routeNotification(t);
    assertEquals(action === "sub_active", false, `${t} must not entitle`);
    assertEquals(action === "sub_expired", false, `${t} must not lapse`);
    assertEquals(action === "revoke", false, `${t} must not revoke`);
  }
});

// Unknown types must still fail closed — widening the router must not have
// turned the default into something permissive.
Deno.test("US-2124: an unknown notification still fails closed to ignore", () => {
  assertEquals(routeNotification("SOME_FUTURE_APPLE_EVENT"), "ignore");
});
