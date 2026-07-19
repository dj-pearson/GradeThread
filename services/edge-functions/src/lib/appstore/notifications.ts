// App Store Server Notifications V2 → coarse action routing (pure). Unknown
// notification types fail closed to "ignore" (no entitlement change).

export type AppstoreAction =
  | "sub_active" // entitle / re-entitle the subscription
  | "sub_expired" // lapse to free
  | "sub_renew_off" // still entitled, but won't auto-renew (cancel at period end)
  | "sub_renew_on" // auto-renew re-enabled
  | "revoke" // refund / family revoke → drop entitlement now
  | "consumable_grant" // one-time charge (credit pack)
  // US-2124: a platform-side change we must RECORD but that does not itself
  // move entitlement. Apple collects price-increase consent natively, so this is
  // not a rejection risk — but the server never learned a price change had
  // happened at all, so an unconsented lapse arrived later as a bare EXPIRED
  // with no way to tell it apart from an ordinary cancellation.
  | "record_only"
  | "ignore";

export function routeNotification(
  notificationType: string,
  subtype?: string | null,
): AppstoreAction {
  switch (notificationType) {
    case "SUBSCRIBED":
    case "DID_RENEW":
    case "OFFER_REDEEMED":
      return "sub_active";
    case "DID_CHANGE_RENEWAL_STATUS":
      // Only an explicit AUTO_RENEW_ENABLED re-enables; anything else (disabled
      // or missing subtype) reads as "won't renew".
      return subtype === "AUTO_RENEW_ENABLED" ? "sub_renew_on" : "sub_renew_off";
    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
      return "sub_expired";
    case "REFUND":
    case "REVOKE":
      return "revoke";
    case "ONE_TIME_CHARGE":
      return "consumable_grant";
    // US-2124 AC2: reflect platform-side changes in server state.
    //
    // PRICE_INCREASE — Apple has told the customer and is collecting (or has
    // collected) their consent. We take no entitlement action: if they refuse,
    // Apple lapses the subscription and we hear EXPIRED. Recording it is what
    // makes that later EXPIRED interpretable rather than a mystery.
    //
    // DID_CHANGE_RENEWAL_PREF — the customer switched plan/tier on Apple's
    // side. Entitlement is carried by the transaction on the next DID_RENEW, so
    // again no immediate change; what matters is that we know it happened.
    case "PRICE_INCREASE":
    case "DID_CHANGE_RENEWAL_PREF":
      return "record_only";
    default:
      return "ignore";
  }
}
