// App Store Server Notifications V2 → coarse action routing (pure). Unknown
// notification types fail closed to "ignore" (no entitlement change).

export type AppstoreAction =
  | "sub_active" // entitle / re-entitle the subscription
  | "sub_expired" // lapse to free
  | "sub_renew_off" // still entitled, but won't auto-renew (cancel at period end)
  | "sub_renew_on" // auto-renew re-enabled
  | "revoke" // refund / family revoke → drop entitlement now
  | "consumable_grant" // one-time charge (credit pack)
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
    default:
      return "ignore";
  }
}
