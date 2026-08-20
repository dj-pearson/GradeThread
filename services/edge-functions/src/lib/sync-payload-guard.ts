// US-2697: what a sold-sync observation batch may never carry.
//
// The extension reads the seller's own Sold and Orders pages. Those pages also
// print the BUYER's name, handle and shipping address, and a future adapter
// that grabs "the whole row" would send them here without anyone deciding to.
// This refuses the key rather than trusting the adapter.
//
// DERIVED, NOT RESTATED. The credential half is imported from extension-queue.ts
// rather than copied. That file's own comment explains why the rule exists in
// three places; what it does not survive is a fourth place holding a stale COPY
// of the list. EXTENSION_DELIST_PLATFORMS was exactly that bug (US-2479/2480):
// a second hand-written copy of a set, silently out of date, and the
// consequence was the oversell the module existed to prevent.

import { CREDENTIAL_KEYS } from "./extension-queue.ts";

/**
 * Buyer identity, on top of the credential keys.
 *
 * Matched the same way CREDENTIAL_KEYS is: case-insensitively, ignoring
 * separators, and by suffix — so `buyer_name`, `buyerName` and `BUYER-NAME` are
 * one refusal, and so is `order.recipient_address`.
 */
export const BUYER_IDENTITY_KEYS = [
  "buyer",
  "buyername",
  "buyerhandle",
  "buyerusername",
  "recipient",
  "address",
  "shippingaddress",
  "street",
  "postcode",
  "zip",
  "phone",
  "email",
] as const;

/** Everything a sync payload may not carry. */
export const SYNC_FORBIDDEN_KEYS: readonly string[] = [
  ...CREDENTIAL_KEYS,
  ...BUYER_IDENTITY_KEYS,
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

function isForbidden(key: string): boolean {
  const k = normalizeKey(key);
  return SYNC_FORBIDDEN_KEYS.some((bad) => k === bad || k.endsWith(bad));
}

/**
 * The first forbidden key anywhere in the payload, or null when it is clean.
 *
 * Walks NESTED objects and arrays, not just the top level: `{ order: { buyer:
 * { address: "…" } } }` is the same leak wearing two more braces, and a
 * top-level-only check is the kind that passes review and fails in production.
 */
export function findForbiddenKey(input: unknown, depth = 0): string | null {
  if (depth > 6) return null; // deeper than any real observation batch goes
  if (!input || typeof input !== "object") return null;

  if (Array.isArray(input)) {
    for (const entry of input) {
      const nested = findForbiddenKey(entry, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isForbidden(key)) return key;
    const nested = findForbiddenKey(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}
