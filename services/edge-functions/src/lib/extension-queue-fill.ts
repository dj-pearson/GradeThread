// US-3455: the phone asks for a create-form fill, the pure half.
//
// The iOS app fills a Poshmark or Mercari create form in a web view the seller
// is signed into and watching. The words it types are the SAME words the
// desktop extension would type for a queued `list` job: hydrateListRows in
// routes/flipdesk-extension-queue.ts builds them (eBay's title and a freshly
// rendered description through channel-copy, the channel's own price, the
// item's brand, colour and size). This module only decides whether a request
// is well-formed enough to hand to that hydration; nothing here reads a row.
//
// No queue row is written. The phone is the browser here, so there is nothing
// for a desktop to drain, and the listing row is minted by the same
// extension-writeback the desktop uses once the seller actually posts.

import { delistMethodFor } from "./cross-listing-sale.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A price as the marketplace input receives it: digits, one optional point. */
const PRICE = /^\d{1,7}(\.\d{1,2})?$/;

export type FillRequest =
  | { ok: true; itemId: string; platform: string; payload: Record<string, string> }
  | { ok: false; error: string };

/**
 * Validate the phone's body. Pure.
 *
 * Only extension-mechanism platforms are accepted: an API channel has a
 * publish route and a manual one has no form the phone knows. The optional
 * `price` rides in the payload exactly as the queued path carries it, so the
 * same merge rule (client keys win) applies.
 */
export function parseFillRequest(body: unknown): FillRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const itemId = typeof b.inventory_item_id === "string" ? b.inventory_item_id : "";
  if (!UUID.test(itemId)) return { ok: false, error: "inventory_item_id must be an item id." };
  const platform = typeof b.platform === "string" ? b.platform : "";
  if (!platform || delistMethodFor(platform) !== "extension") {
    return { ok: false, error: `Unsupported platform: ${platform || "(none)"}.` };
  }
  const payload: Record<string, string> = {};
  if (b.price !== undefined && b.price !== null && b.price !== "") {
    const price = typeof b.price === "number" ? String(b.price) : String(b.price).trim();
    if (!PRICE.test(price)) return { ok: false, error: "price must be a plain number." };
    payload.price = price;
  }
  return { ok: true, itemId, platform, payload };
}
