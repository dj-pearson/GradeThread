// Fulfillment/return signals parsed out of a seller's eBay business policies
// (US-1897). These are the three policy-derived factors eBay NAMES in its Best
// Match guidance: returns accepted, fast (≤1 day) handling, and free shipping.
//
// WHY A PARSER AND NOT A FIELD ON PolicySet. `PolicySet` (ebay-client.ts) carries
// only the four policy IDs, because that is all the publish call needs. The
// actual terms live in `business_policies.policy_data`, a jsonb column into which
// syncBusinessPolicies writes eBay's ENTIRE raw policy object. So the data is
// already synced; nothing here fetches anything. Parsing it in its own pure lib
// keeps the shape eBay controls at one boundary, instead of spreading optional
// chaining through the scorer.
//
// EVERYTHING FAILS TO `null`, NEVER TO `false`. "We could not read this policy"
// and "this seller does not accept returns" are different facts, and collapsing
// them would tell a seller to go fix something already correct. The scorer treats
// null as "unknown" and declines to award or penalise the component.

/** eBay's `timeDuration` shape: { value, unit: "DAY" | "HOUR" | … }. */
interface TimeDuration {
  value?: unknown;
  unit?: unknown;
}

export interface FulfillmentSignals {
  /** Return policy accepts returns. null = unreadable/absent policy. */
  returnsAccepted: boolean | null;
  /** Handling time in DAYS, normalised from eBay's value+unit. null = unknown. */
  handlingDays: number | null;
  /** At least one shipping service is free to the buyer. null = unknown. */
  freeShipping: boolean | null;
}

export const UNKNOWN_FULFILLMENT: FulfillmentSignals = {
  returnsAccepted: null,
  handlingDays: null,
  freeShipping: null,
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Normalise eBay's { value, unit } duration to whole days.
 * HOUR is converted (24h = 1 day) rather than rejected: a 24-hour handling time
 * is the same promise as 1 day, and treating it as unknown would under-score a
 * seller who is actually meeting the bar.
 */
export function handlingToDays(raw: unknown): number | null {
  const d = asRecord(raw) as TimeDuration | null;
  if (!d) return null;
  const value = typeof d.value === "number" ? d.value : Number(d.value);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = typeof d.unit === "string" ? d.unit.toUpperCase() : "";
  if (unit === "DAY" || unit === "BUSINESS_DAY" || unit === "CALENDAR_DAY") return value;
  if (unit === "HOUR") return value / 24;
  return null; // unrecognised unit — do not guess
}

/**
 * True when any shipping service on any option ships free to the buyer.
 *
 * eBay expresses this two ways depending on policy vintage: an explicit
 * `freeShipping: true` flag, or a `shippingCost.value` of 0. Both are accepted.
 * Only DOMESTIC options count — a free international service does not make the
 * listing free-shipping for the buyers Best Match is ranking for.
 */
export function hasFreeShipping(policyData: unknown): boolean | null {
  const p = asRecord(policyData);
  if (!p) return null;
  const options = asArray(p.shippingOptions);
  if (!options.length) return null;

  let sawDomestic = false;
  for (const optRaw of options) {
    const opt = asRecord(optRaw);
    if (!opt) continue;
    const type = typeof opt.optionType === "string" ? opt.optionType.toUpperCase() : "";
    // Absent optionType is treated as domestic: older policies omit it, and the
    // common case by far is a domestic-only policy.
    if (type && type !== "DOMESTIC") continue;
    sawDomestic = true;
    for (const svcRaw of asArray(opt.shippingServices)) {
      const svc = asRecord(svcRaw);
      if (!svc) continue;
      if (svc.freeShipping === true) return true;
      const cost = asRecord(svc.shippingCost);
      const val = cost ? Number(cost.value) : NaN;
      if (Number.isFinite(val) && val === 0) return true;
    }
  }
  return sawDomestic ? false : null;
}

/** Return policy → returnsAccepted. */
export function parseReturnsAccepted(policyData: unknown): boolean | null {
  const p = asRecord(policyData);
  if (!p) return null;
  return typeof p.returnsAccepted === "boolean" ? p.returnsAccepted : null;
}

/**
 * Combine the seller's default fulfillment + return policy_data blobs into the
 * three signals the quality score reads. Either may be null/absent.
 */
export function parseFulfillmentSignals(
  fulfillmentPolicyData: unknown,
  returnPolicyData: unknown,
): FulfillmentSignals {
  const f = asRecord(fulfillmentPolicyData);
  return {
    returnsAccepted: parseReturnsAccepted(returnPolicyData),
    handlingDays: f ? handlingToDays(f.handlingTime) : null,
    freeShipping: hasFreeShipping(fulfillmentPolicyData),
  };
}
