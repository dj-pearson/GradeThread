// The seller-to-EasyPost-referral-customer mapping (US-3015, AC2/AC3/AC11).
//
// One row per seller in easypost_accounts, holding a pointer and an encrypted
// API key. Not money: EasyPost-Managed Billing means the seller's own card is
// charged by EasyPost, so there is no balance to hold and no float to
// reconcile. The table has no balance column and this module has no code that
// would want one.
//
// TENANCY (US-268). Every query here is scoped on owner_user_id, and the owner
// id ALWAYS comes from the request context, never from a body. An EasyPost
// account id off a request is not an input to anything in this file -- there is
// no lookup by easypost_user_id at all, precisely so that a forged one has
// nowhere to land.
//
// THE KEY NEVER LEAVES THE EDGE. easypostReadiness() returns booleans and a
// timestamp; nothing here returns the key to a caller that could serialize it.
// A client that could read it could spend the seller's postage money from
// anywhere.

import { supabaseAdmin } from "./supabase.ts";
import { decryptToken, encryptToken } from "./crypto-aes.ts";
import {
  createReferralCustomer,
  hasPaymentMethod,
  isEasyPostConfigured,
} from "./easypost.ts";

export interface EasyPostAccount {
  easypostUserId: string;
  /** Decrypted. Edge-only; never returned to a client. */
  apiKey: string | null;
  paymentMethodVerifiedAt: string | null;
}

interface AccountRow {
  easypost_user_id: string;
  api_key_encrypted: string | null;
  payment_method_verified_at: string | null;
}

/** This seller's EasyPost account, or null when they have never onboarded. */
export async function loadEasyPostAccount(
  ownerId: string,
): Promise<EasyPostAccount | null> {
  const { data, error } = await supabaseAdmin
    .from("easypost_accounts")
    .select("easypost_user_id, api_key_encrypted, payment_method_verified_at")
    .eq("owner_user_id", ownerId) // US-268
    .maybeSingle();
  if (error) {
    // Before 00816 applies this is an unknown-relation error, and "no account"
    // is the right reading: the capability then rests on the env var alone,
    // which renders as onboarding rather than as a broken feature.
    console.warn("[easypost] account read failed:", error.message);
    return null;
  }
  const row = data as AccountRow | null;
  if (!row) return null;
  let apiKey: string | null = null;
  if (row.api_key_encrypted) {
    try {
      apiKey = await decryptToken(row.api_key_encrypted, { aad: ownerId });
    } catch (err) {
      // A decrypt failure must NOT read as "no account" -- that renders as an
      // onboarding prompt, and a seller who follows it would create a SECOND
      // referral customer at EasyPost and leave the first one orphaned.
      console.error(
        "[easypost] account key decrypt failed for",
        ownerId,
        err instanceof Error ? err.message : String(err),
      );
      throw new Error("Your EasyPost account could not be unlocked.");
    }
  }
  return {
    easypostUserId: row.easypost_user_id,
    apiKey,
    paymentMethodVerifiedAt: row.payment_method_verified_at,
  };
}

export interface EasyPostReadiness {
  /** EASYPOST_API_KEY is set on this deployment (AC12). */
  configured: boolean;
  /** This seller has a referral customer. */
  hasAccount: boolean;
  /** ...and a payment method on it, so a buy will not fail (AC3). */
  ready: boolean;
}

/**
 * Can EasyPost serve this seller right now?
 *
 * Read BEFORE the buy button renders, which is the whole of AC3: a seller who
 * never finished onboarding sees a prompt instead of discovering it from a
 * failed purchase. The payment-method answer is cached on the row once seen,
 * because it only ever goes from false to true through a seller action -- and
 * a card REMOVED later surfaces on the buy, where isPaymentMethodError()
 * catches it.
 */
export async function easypostReadiness(
  ownerId: string,
): Promise<EasyPostReadiness> {
  if (!isEasyPostConfigured()) {
    return { configured: false, hasAccount: false, ready: false };
  }
  let account: EasyPostAccount | null;
  try {
    account = await loadEasyPostAccount(ownerId);
  } catch {
    // A locked key is not "no account" and not "ready" either. Reporting
    // hasAccount here keeps the client off the onboarding path, which would
    // mint a duplicate customer.
    return { configured: true, hasAccount: true, ready: false };
  }
  if (!account) return { configured: true, hasAccount: false, ready: false };
  if (account.paymentMethodVerifiedAt) {
    return { configured: true, hasAccount: true, ready: true };
  }
  if (!account.apiKey) {
    return { configured: true, hasAccount: true, ready: false };
  }
  let ready = false;
  try {
    ready = await hasPaymentMethod(account.apiKey);
  } catch (err) {
    // EasyPost being down is not the seller's onboarding problem. Fail to
    // "not ready" so nothing is bought against an unknown billing state, but
    // do not record the answer.
    console.warn(
      "[easypost] payment-method probe failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { configured: true, hasAccount: true, ready: false };
  }
  if (ready) await markPaymentMethodVerified(ownerId);
  return { configured: true, hasAccount: true, ready };
}

/** Best-effort stamp. A failed write costs one extra probe, never a purchase. */
export async function markPaymentMethodVerified(ownerId: string): Promise<void> {
  try {
    await supabaseAdmin
      .from("easypost_accounts")
      .update({ payment_method_verified_at: new Date().toISOString() })
      .eq("owner_user_id", ownerId) // US-268
      .is("payment_method_verified_at", null);
  } catch (err) {
    console.warn(
      "[easypost] payment-method stamp failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Create this seller's referral customer, once.
 *
 * Returns the EXISTING account when there is one rather than minting a second.
 * A duplicate referral customer is not a harmless retry: the seller's card goes
 * on one of them, and every later buy runs on whichever key we stored last, so
 * the duplicate shows up as a purchase that fails for no visible reason.
 */
export async function ensureEasyPostAccount(
  ownerId: string,
  profile: { name: string | null; email: string; phone?: string | null },
): Promise<EasyPostAccount> {
  const existing = await loadEasyPostAccount(ownerId);
  if (existing) return existing;

  const created = await createReferralCustomer(profile);
  if (!created.easypostUserId) {
    throw new Error("EasyPost did not return a customer id.");
  }
  const encrypted = created.apiKey
    ? await encryptToken(created.apiKey, { aad: ownerId })
    : null;

  const { error } = await supabaseAdmin
    .from("easypost_accounts")
    .upsert(
      {
        owner_user_id: ownerId, // US-268
        easypost_user_id: created.easypostUserId,
        api_key_encrypted: encrypted,
      },
      { onConflict: "owner_user_id" },
    );
  if (error) {
    // The customer EXISTS at EasyPost now. Losing the row means the next
    // onboarding attempt mints another one, so this is loud rather than
    // swallowed, and it names the id so the orphan can be found.
    console.error(
      "[easypost] referral customer created but not stored:",
      created.easypostUserId,
      error.message,
    );
    throw new Error("Your EasyPost account was created but could not be saved.");
  }
  return {
    easypostUserId: created.easypostUserId,
    apiKey: created.apiKey,
    paymentMethodVerifiedAt: null,
  };
}
