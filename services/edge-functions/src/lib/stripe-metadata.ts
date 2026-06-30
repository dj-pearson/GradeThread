// US-1414 / US-1419: resolve our app metadata (user_id, product, credits,
// submission_id) from Stripe webhook objects.
//
// THE TRAP: Checkout writes our metadata to the PaymentIntent
// (payment_intent_data.metadata) and the Session — Stripe does NOT copy
// PaymentIntent metadata onto the Charge. And in a raw `charge.dispute.created`
// webhook the dispute's `payment_intent` is an UNEXPANDED string id. So a
// handler that keys off `charge.metadata` / `dispute.payment_intent.metadata`
// sees {} for every Checkout-originated payment — silently skipping credit-pack
// clawbacks (value leak) and per-grade certificate withholding (trust hole).
//
// These helpers prefer the object's own metadata when it already carries our
// user_id, else fall back to retrieving the PaymentIntent's metadata. The PI
// fetcher is injected so the resolution logic is unit-testable without Stripe.

import type Stripe from "stripe";

export type StripeMetadata = Record<string, string>;

/** Retrieve a PaymentIntent's metadata by id (null on any failure). */
export type PaymentIntentMetadataFetcher = (
  id: string,
) => Promise<StripeMetadata | null>;

/** True when metadata carries our app's user_id (i.e. it's our metadata). */
export function hasAppMetadata(
  meta: Stripe.Metadata | StripeMetadata | null | undefined,
): boolean {
  return typeof meta?.user_id === "string" && meta.user_id.length > 0;
}

/** Normalize a string | expanded-object | null PaymentIntent ref to its id. */
export function paymentIntentIdOf(
  ref: string | { id?: string | null } | null | undefined,
): string | null {
  if (!ref) return null;
  if (typeof ref === "string") return ref.length > 0 ? ref : null;
  return ref.id ?? null;
}

/**
 * Effective metadata for a refunded Charge: the charge's own metadata if it
 * carries our user_id, else the linked PaymentIntent's metadata.
 */
export async function resolveChargeMetadata(
  charge: Pick<Stripe.Charge, "metadata" | "payment_intent">,
  fetchPi: PaymentIntentMetadataFetcher,
): Promise<StripeMetadata> {
  const own = (charge.metadata ?? {}) as StripeMetadata;
  if (hasAppMetadata(own)) return { ...own };

  const piId = paymentIntentIdOf(charge.payment_intent ?? null);
  if (!piId) return { ...own };

  const piMeta = await fetchPi(piId);
  return hasAppMetadata(piMeta) ? { ...(piMeta as StripeMetadata) } : { ...own };
}

/**
 * Effective metadata for a Dispute: the expanded PaymentIntent's metadata if
 * present, else the metadata of the PaymentIntent fetched by its id. Returns {}
 * when no PaymentIntent can be resolved.
 */
export async function resolveDisputeMetadata(
  dispute: Pick<Stripe.Dispute, "payment_intent">,
  fetchPi: PaymentIntentMetadataFetcher,
): Promise<StripeMetadata> {
  const pi = dispute.payment_intent;
  if (pi && typeof pi !== "string" && hasAppMetadata(pi.metadata)) {
    return { ...(pi.metadata as StripeMetadata) };
  }
  const piId = paymentIntentIdOf(pi ?? null);
  if (!piId) return {};
  const piMeta = await fetchPi(piId);
  return hasAppMetadata(piMeta) ? { ...(piMeta as StripeMetadata) } : {};
}
