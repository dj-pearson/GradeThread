// US-2328: push tracking to Shopify when a FlipDesk order ships.
//
// The coverage matrix listed Shopify as REAL for connect / list / sync / delist
// / price-revise and SHELL for ship, and that was accurate: there was no
// fulfillment call anywhere in the repo. A seller who shipped a Shopify order
// through FlipDesk left the Shopify order unfulfilled forever — so Shopify
// never emailed the buyer their tracking, and the order sat in the merchant's
// admin looking unshipped.
//
// ── WHY THIS IS TWO API CALLS AND NOT ONE ───────────────────────────────────
// Shopify does not fulfil an ORDER. Since the 2022 fulfillment-orders migration
// the unit is the FULFILLMENT ORDER — an order split by location and by who is
// responsible for it, so a single order can have several. `fulfillmentCreate`
// takes fulfillment-order ids, never an order id. So we read the order's
// fulfillment orders first and fulfil the ones actually assigned to us.
//
// Getting this wrong fails in a quiet way rather than a loud one: fulfilling
// only the first fulfillment order on a multi-location order marks part of it
// shipped and silently leaves the rest, which reads as success everywhere.
import { shopifyGraphql, ShopifyGraphqlError } from "./shopify-graphql.ts";

/** A fulfillment order as returned by the query below. */
export interface FulfillmentOrderLite {
  id: string;
  status: string;
  requestStatus?: string | null;
}

export interface ShopifyTrackingInput {
  trackingNumber: string;
  /** Shopify shows the carrier name; it also uses it to pick a tracking URL. */
  carrier?: string | null;
  /** Whether Shopify emails the buyer. Defaults to true — that is the point. */
  notifyCustomer?: boolean;
}

/**
 * Fulfillment orders we may act on.
 *
 * OPEN and IN_PROGRESS are fulfillable. CLOSED means already fulfilled, and
 * anything held / cancelled / incomplete is not ours to move.
 *
 * `requestStatus` matters separately: a fulfillment order handed to a
 * third-party fulfillment service is one we must NOT fulfil ourselves, even
 * though its status is OPEN. Submitting for it would be claiming someone else's
 * work is done.
 */
export const FULFILLABLE_STATUSES = new Set(["OPEN", "IN_PROGRESS"]);
const THIRD_PARTY_REQUEST_STATUSES = new Set([
  "SUBMITTED",
  "ACCEPTED",
  "CLOSED",
]);

export function selectFulfillableOrders(
  orders: readonly FulfillmentOrderLite[],
): FulfillmentOrderLite[] {
  return orders.filter(
    (o) =>
      FULFILLABLE_STATUSES.has(o.status) &&
      !THIRD_PARTY_REQUEST_STATUSES.has(o.requestStatus ?? ""),
  );
}

export const FULFILLMENT_ORDERS_QUERY = `
  query FulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 20) {
        nodes { id status requestStatus }
      }
    }
  }
`;

export const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status trackingInfo { number company } }
      userErrors { field message }
    }
  }
`;

export interface ShopifyUserError {
  field?: string[] | null;
  message: string;
}

/**
 * Turn Shopify's `userErrors` into a thrown error.
 *
 * AC2: a fulfilment that did not happen must not read as one that did.
 * `fulfillmentCreate` returns HTTP 200 with a populated `userErrors` array when
 * it refuses — so a caller checking only the transport status sees success and
 * tells the seller their buyer has tracking. That is the specific failure this
 * function exists to prevent, and it is why the route surfaces the message
 * rather than logging it.
 */
export function assertNoUserErrors(
  errors: readonly ShopifyUserError[] | null | undefined,
): void {
  if (!errors || errors.length === 0) return;
  const detail = errors
    .map((e) => {
      const where = e.field?.length ? `${e.field.join(".")}: ` : "";
      return `${where}${e.message}`;
    })
    .join("; ");
  throw new ShopifyGraphqlError(`Shopify refused the fulfillment — ${detail}`, []);
}

export interface FulfillmentResult {
  /** How many fulfillment orders we actually submitted. */
  fulfilled: number;
  /** Shopify fulfillment ids, for the audit trail. */
  fulfillmentIds: string[];
  /** True when the order had nothing left to fulfil. */
  alreadyFulfilled: boolean;
}

export interface FulfillmentDeps {
  graphql: typeof shopifyGraphql;
}

/**
 * Create a Shopify fulfillment carrying the tracking number.
 *
 * Every fulfillable fulfillment order is submitted, not just the first: a
 * multi-location order otherwise ends up half-shipped with nothing saying so.
 */
export async function createShopifyFulfillment(
  shop: string,
  token: string,
  orderGid: string,
  tracking: ShopifyTrackingInput,
  deps: FulfillmentDeps = { graphql: shopifyGraphql },
): Promise<FulfillmentResult> {
  const read = await deps.graphql<{
    order: { fulfillmentOrders: { nodes: FulfillmentOrderLite[] } } | null;
  }>(shop, token, FULFILLMENT_ORDERS_QUERY, { id: orderGid });

  const order = read.data?.order;
  if (!order) {
    throw new ShopifyGraphqlError(
      `Shopify has no order ${orderGid} — it may have been deleted, or belong ` +
        `to a different shop than the connected one.`,
      [],
    );
  }

  const fulfillable = selectFulfillableOrders(order.fulfillmentOrders?.nodes ?? []);
  if (fulfillable.length === 0) {
    // Not an error. Re-shipping an already-fulfilled order is the common case
    // (a retry, or a seller correcting tracking), and throwing here would turn
    // a no-op into a red banner.
    return { fulfilled: 0, fulfillmentIds: [], alreadyFulfilled: true };
  }

  const fulfillmentIds: string[] = [];
  for (const fo of fulfillable) {
    const res = await deps.graphql<{
      fulfillmentCreate: {
        fulfillment: { id: string } | null;
        userErrors: ShopifyUserError[];
      };
    }>(shop, token, FULFILLMENT_CREATE_MUTATION, {
      fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id }],
        notifyCustomer: tracking.notifyCustomer ?? true,
        trackingInfo: {
          number: tracking.trackingNumber,
          ...(tracking.carrier ? { company: tracking.carrier } : {}),
        },
      },
    });
    assertNoUserErrors(res.data?.fulfillmentCreate?.userErrors);
    const id = res.data?.fulfillmentCreate?.fulfillment?.id;
    if (!id) {
      // No id and no userErrors is a shape we do not understand. Refusing is
      // the safe reading: the alternative is reporting a fulfilment we cannot
      // point at.
      throw new ShopifyGraphqlError(
        "Shopify returned no fulfillment and no error — nothing was confirmed.",
        [],
      );
    }
    fulfillmentIds.push(id);
  }

  return {
    fulfilled: fulfillmentIds.length,
    fulfillmentIds,
    alreadyFulfilled: false,
  };
}
