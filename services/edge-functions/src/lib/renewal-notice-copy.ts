// US-2119: the two things an advance renewal notice must get right about WHICH
// subscription is renewing.
//
// GradeThread sells two subscriptions on one Stripe customer: the seller product
// (FlipDesk Starter/Pro/Business) and the buyer product (GradeThread
// Guard/Connoisseur). They are managed on different pages. Until now the notice
// existed only for the seller one and hardcoded both values, so wiring the buyer
// in meant either branching inside a 40-line HTML template or copying it — and a
// copied template is how two near-identical emails drift apart.
//
// Pulled out here instead, as data with no IO, because the failure it prevents
// is specific and quiet: a notice that names the wrong product and links to a
// page that cannot cancel the thing being charged. That reads as a correct
// email. The recipient only discovers otherwise after the money is taken, which
// is the exact moment this notice exists to precede.

export type SubscriptionProduct = "flipdesk" | "buyer";

export interface RenewalNoticeCopy {
  /** The product name as it is sold, e.g. "FlipDesk Pro" is productName + plan. */
  productName: string;
  /** Absolute URL of the page that can actually cancel THIS subscription. */
  manageUrl: string;
}

export function renewalNoticeCopy(
  product: SubscriptionProduct,
  siteUrl: string,
): RenewalNoticeCopy {
  const base = siteUrl.replace(/\/+$/, "");
  return product === "buyer"
    ? { productName: "GradeThread", manageUrl: `${base}/buyer/billing` }
    : { productName: "FlipDesk", manageUrl: `${base}/dashboard/billing` };
}
