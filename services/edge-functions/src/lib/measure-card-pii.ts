// US-2417 AC2: the street address on a MeasureCard request is stored as
// AES-256-GCM ciphertext, bound to the owner.
//
// The story's own framing is the point: OAuth tokens sitting in the next table
// over have been encrypted since US-352, while a seller's home address sat in
// plaintext. A stolen database dump is the same event for both, and only one of
// them is a place a person lives.
//
// ── WHY THIS TABLE AND NOT users.ship_from_address ──────────────────────────
// AC1 asks for the same treatment on users.ship_from_address and
// users.business_phone. THAT IS NOT REACHABLE YET, and the reason is a fact
// about the write path rather than a preference:
//
//   src/pages/settings.tsx:306 writes both columns with supabase-js DIRECTLY
//   from the browser, under RLS, and 00526_users_self_update_allowlist.sql
//   explicitly allowlists them. They are read the same way — settings.tsx,
//   flipdesk/marketplaces.tsx and lib/account-export.ts all read them client
//   side.
//
// EDGE_ENCRYPTION_KEY is an edge-only secret and must stay one. So encrypting
// those two columns first requires moving that write and all three reads behind
// an edge route. That is a real piece of work the story does not name, and
// doing the crypto without it would lock the seller out of their own Settings
// page. Recorded on US-2417 rather than half-done here.
//
// measure_card_requests has no such problem: it is a deny-all operator table
// (rls-guard_test.ts:181), written by exactly one edge route
// (flipdesk-measure.ts POST /card-request) and read by exactly one
// (admin-measure-cards.ts listRequests → the fulfilment CSV). Both sides
// already run where the key lives.
//
// ── WHAT STAYS PLAINTEXT, AND WHY THAT IS NOT LAZINESS ──────────────────────
// `state` and `country` are NOT encrypted, per AC2. The fulfilment export
// filters and sorts by region, and a WHERE on an encrypted column cannot use an
// index or an equality at all — every row would have to be pulled and decrypted
// to answer "which requests go to CA". A region is also far weaker as an
// identifier than a street line. `status`, `plan_key` and the timestamps are
// operational, not identifying.
//
// ── ROLLOUT TOLERANCE (AC4) ─────────────────────────────────────────────────
// decryptMeasureCardAddress returns a value that is not in the v1:/v2: format
// AS-IS. A partially backfilled table therefore renders rather than throwing,
// which matters because the reader here is the operator's fulfilment queue: a
// 500 on one un-backfilled row would take out the whole export, and an operator
// blocked from shipping cards is a worse outcome than an address that has not
// been encrypted yet. The tolerance is one-directional — writes are always
// encrypted, so the plaintext population only shrinks.

import { decryptToken, encryptToken } from "./crypto-aes.ts";

/**
 * The columns that identify where a person lives.
 *
 * `address_line2` is nullable and the rest are NOT NULL (00351), which is why
 * the helpers below preserve null rather than encrypting the string "null" —
 * a NOT NULL column cannot take one and a nullable one must stay empty.
 */
export const MEASURE_CARD_PII_COLUMNS = [
  "ship_name",
  "address_line1",
  "address_line2",
  "city",
  "postal_code",
] as const;

export type MeasureCardPiiColumn = typeof MEASURE_CARD_PII_COLUMNS[number];

/** Columns deliberately left readable — see the header. */
export const MEASURE_CARD_PLAINTEXT_COLUMNS = ["state", "country"] as const;

export type MeasureCardAddress = Partial<Record<MeasureCardPiiColumn, string | null>>;

/** True when a stored value is already in the crypto-aes envelope format. */
export function isEncrypted(value: string): boolean {
  return value.startsWith("v1:") || value.startsWith("v2:");
}

/**
 * Encrypt every address column, binding each ciphertext to the owner.
 *
 * THE AAD IS THE POINT (AC7). AES-GCM covers additionalData with the auth tag,
 * so a ciphertext lifted onto another seller's row fails to decrypt instead of
 * quietly revealing the first seller's address to whoever owns the second row.
 * That is the US-268 tenant property expressed in cryptography rather than in a
 * `.eq()` someone has to remember.
 *
 * Already-encrypted values are passed through, so a backfill that runs twice
 * does not double-wrap — which would be unrecoverable, because the inner
 * envelope's AAD is not visible from the outside.
 */
export async function encryptMeasureCardAddress(
  ownerUserId: string,
  address: MeasureCardAddress,
): Promise<MeasureCardAddress> {
  if (!ownerUserId) throw new Error("measure-card PII: ownerUserId is required as AAD");
  const out: MeasureCardAddress = {};
  for (const col of MEASURE_CARD_PII_COLUMNS) {
    const value = address[col];
    if (value == null || value === "") {
      out[col] = value ?? null;
      continue;
    }
    out[col] = isEncrypted(value) ? value : await encryptToken(value, { aad: ownerUserId });
  }
  return out;
}

/**
 * Decrypt every address column for display/export.
 *
 * A value that is not in the envelope format is returned unchanged (AC4). A
 * value that IS in the envelope format and fails to decrypt is NOT swallowed —
 * that is either a wrong key or a row whose ciphertext was moved between
 * tenants, and both are things an operator must see rather than read as an
 * empty address field.
 */
export async function decryptMeasureCardAddress<T extends MeasureCardAddress>(
  ownerUserId: string,
  row: T,
): Promise<T> {
  const out = { ...row };
  for (const col of MEASURE_CARD_PII_COLUMNS) {
    const value = row[col];
    if (value == null || value === "" || !isEncrypted(value)) continue;
    (out as MeasureCardAddress)[col] = await decryptToken(value, { aad: ownerUserId });
  }
  return out;
}
