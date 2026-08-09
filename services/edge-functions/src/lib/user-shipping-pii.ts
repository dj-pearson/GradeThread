// US-2417 AC1: users.ship_from_address and users.business_phone stored as
// AES-256-GCM ciphertext, bound to the account owner.
//
// This is the half measure-card-pii.ts said was not reachable yet, and its
// header explains why: both columns were written and read DIRECTLY from the
// browser under RLS, and EDGE_ENCRYPTION_KEY is an edge-only secret that has to
// stay one. So the prerequisite was moving that traffic behind an edge route,
// not the crypto. `/api/account/shipping-profile` (account.ts) is that route,
// migration 00567 drops both columns from the users self-update allowlist so the
// browser cannot write around it, and only then does this file mean anything.
//
// ── THE STORAGE SHAPE, WHICH IS THE ONE NON-OBVIOUS DECISION ────────────────
//
// `ship_from_address` is `jsonb` (00325) and an envelope is a string. The story
// note assumed that forces a column type change. It does not: a jsonb column
// holds a JSON *string* scalar perfectly well, so the ciphertext lives in the
// existing column as `"v2:…"` rather than as `{"line1":…}`.
//
// That is not a dodge, it is a better discriminator than a type change would
// have given us. The rollout tolerance AC4 asks for needs a way to tell a
// not-yet-backfilled row from an encrypted one, and here the JSON TYPE is that
// answer: an object is legacy plaintext, a string is an envelope. No prefix
// sniffing on a value that might legitimately begin with anything, and no
// ALTER COLUMN TYPE rewriting a live table under a lock.
//
// business_phone is `text`, so it keeps the v1:/v2: prefix test that the
// marketplace tokens and the measure-card columns already use.
//
// ── WHY THE WHOLE ADDRESS, WHEN measure_card_requests LEAVES REGION CLEAR ───
//
// measure-card-pii.ts deliberately leaves `state` and `country` in plaintext,
// because the operator's fulfilment export filters and sorts by region and an
// equality on ciphertext cannot use an index. Nothing filters users by
// ship-from region — the column is read one row at a time, by its owner or for
// their own shipping label — so there is no query to preserve and the whole
// object is encrypted as one envelope. Fewer moving parts and a strictly
// stronger result; the asymmetry between the two files is a consequence of what
// each column is USED for, not an inconsistency.

import { decryptToken, encryptToken } from "./crypto-aes.ts";

/** The address shape settings.tsx writes and the shipping label reads. */
export interface ShipFromAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

const ADDRESS_FIELDS = [
  "line1",
  "line2",
  "city",
  "state",
  "postal_code",
  "country",
] as const;

/** True when a stored text value is already in the crypto-aes envelope format. */
export function isEncrypted(value: string): boolean {
  return value.startsWith("v1:") || value.startsWith("v2:");
}

/**
 * Keep only the six known fields, trimmed, and drop the empties.
 *
 * Applied on the way IN so an envelope never carries a field nobody reads, and
 * so a caller cannot smuggle arbitrary keys into a column that is now opaque to
 * every database-side check. Returns null when nothing survives, which is what
 * "the seller cleared their address" has always meant on this column.
 */
export function normalizeShipFrom(raw: unknown): ShipFromAddress | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: ShipFromAddress = {};
  let any = false;
  for (const f of ADDRESS_FIELDS) {
    const v = src[f];
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) continue;
    out[f] = s;
    any = true;
  }
  return any ? out : null;
}

/**
 * Encrypt an address into the value to STORE in the jsonb column.
 *
 * Returns a plain string; supabase-js sends it as a JSON string scalar, which
 * is what the column then holds. Null in, null out — an absent address stays
 * absent rather than becoming the ciphertext of "null".
 *
 * THE AAD IS THE POINT (AC7). AES-GCM covers additionalData with the auth tag,
 * so a ciphertext lifted onto another account's row fails to decrypt instead of
 * quietly handing that account the first seller's home address. That is the
 * US-268 tenant property expressed in cryptography rather than in an `.eq()`
 * somebody has to remember to write.
 */
export async function encryptShipFrom(
  ownerUserId: string,
  address: unknown,
): Promise<string | null> {
  if (!ownerUserId) throw new Error("shipping PII: ownerUserId is required as AAD");
  // Already an envelope: pass it through rather than wrapping it again.
  // Double-wrapping is UNRECOVERABLE, because the inner envelope's AAD is not
  // visible from the outside — this is what makes a re-run of the backfill a
  // no-op instead of a data-loss event.
  if (typeof address === "string") {
    return isEncrypted(address) ? address : null;
  }
  const normalized = normalizeShipFrom(address);
  if (!normalized) return null;
  return await encryptToken(JSON.stringify(normalized), { aad: ownerUserId });
}

/**
 * Decrypt whatever the column holds into an address, or null.
 *
 * AC4's tolerance, and it is one-directional: an OBJECT is a row the backfill
 * has not reached yet and is returned as-is, so a partially backfilled table
 * renders the Settings page instead of 500ing it. Writes always encrypt, so the
 * plaintext population only ever shrinks.
 *
 * A value that IS an envelope and fails to decrypt THROWS. That is either the
 * wrong key or a ciphertext moved between accounts, and both are things someone
 * must see rather than read as "this seller has no address" — which would look
 * identical to a cleared field and would send them to Settings to re-enter data
 * that is already there.
 */
export async function decryptShipFrom(
  ownerUserId: string,
  stored: unknown,
): Promise<ShipFromAddress | null> {
  if (stored == null) return null;
  if (typeof stored === "object") return normalizeShipFrom(stored);
  if (typeof stored !== "string") return null;
  if (!isEncrypted(stored)) {
    // A bare string that is not an envelope was never a valid value for this
    // column. Treat it as absent rather than guessing at it.
    return null;
  }
  const json = await decryptToken(stored, { aad: ownerUserId });
  try {
    return normalizeShipFrom(JSON.parse(json));
  } catch {
    // Decryption succeeded (so the key and the AAD are right) but the plaintext
    // is not the JSON we wrote. Nothing useful to salvage.
    return null;
  }
}

/** Encrypt the phone for storage. Null and empty stay empty. */
export async function encryptBusinessPhone(
  ownerUserId: string,
  phone: string | null | undefined,
): Promise<string | null> {
  if (!ownerUserId) throw new Error("shipping PII: ownerUserId is required as AAD");
  const trimmed = typeof phone === "string" ? phone.trim() : "";
  if (!trimmed) return null;
  if (isEncrypted(trimmed)) return trimmed; // see encryptShipFrom on re-runs
  return await encryptToken(trimmed, { aad: ownerUserId });
}

/** Decrypt the phone. Same tolerance and same refusal to swallow as above. */
export async function decryptBusinessPhone(
  ownerUserId: string,
  stored: string | null | undefined,
): Promise<string | null> {
  if (!stored) return null;
  if (!isEncrypted(stored)) return stored; // not backfilled yet (AC4)
  return await decryptToken(stored, { aad: ownerUserId });
}
