// US-3138: Action Credits. Prepaid top-ups for metered actions, never expire.
//
// A seller who exhausts their monthly AI-action allowance used to have two
// options: upgrade a tier, or stop working until the month rolled over. This is
// the third. One wallet (00763) that any metered action falls back to, rather
// than one pack per meter, because every new consumable SKU costs an App Store
// Connect setup plus a review. One wallet means the SKUs are created once and a
// new metered feature is one row in ACTION_CREDIT_COSTS below.
//
// Stripe price ids come from env. The code is inert until they are configured:
// the checkout route returns 503 "Pricing not configured", which is correct.
//
// NOT for grading. Grade credits are their own wallet with their own price
// ladder (grade-pricing.ts, users.grade_credit_balance), deliberately.

import { supabaseAdmin } from "./supabase.ts";
import { AI_ACTION_LIMITS } from "./ai-quota.ts";

// ── The meters a credit can pay for ─────────────────────────────────

/** A metered action that can be paid for out of the Action Credit wallet. */
export type ActionMeter = "ai_action" | "connector_action";

/**
 * Credits per action, by meter. v1 is flat, because "1 credit = 1 action" is a
 * sentence a seller can hold in their head and any other answer needs a table
 * in the UI.
 *
 * It is a table rather than a hardcoded 1 so a genuinely expensive future
 * action (a walk-around video grade, a multi-image authenticity pass) can cost
 * 3 or 5 without a new SKU, a new Stripe product, or an App Store review.
 */
export const ACTION_CREDIT_COSTS: Record<ActionMeter, number> = {
  ai_action: 1,
  connector_action: 1,
};

export function creditCostFor(meter: ActionMeter): number {
  return ACTION_CREDIT_COSTS[meter];
}

// ── The packs ───────────────────────────────────────────────────────

export type ActionCreditPackKey = "50" | "150" | "400" | "1000";

/** Smallest to largest. The display order, and the order the ladder guard walks. */
export const ACTION_CREDIT_PACK_KEYS: readonly ActionCreditPackKey[] = [
  "50",
  "150",
  "400",
  "1000",
];

export interface ActionCreditPack {
  key: ActionCreditPackKey;
  credits: number;
  priceCents: number;
  /** Env var holding the Stripe (one-time) price id for this pack. */
  priceEnv: string;
  /** App Store Connect product id. Permanent once created. */
  appstoreProductId: string;
  /** Google Play Console product id. Permanent once created. */
  playProductId: string;
}

/**
 * THE PRICING RULE, so a future re-price does not quietly break the business.
 *
 * Each plan implies a per-AI-action rate: Starter $29/200 = 14.5c, Pro
 * $59/750 = 7.9c, Business $99/2000 = 5.0c. Every pack here is priced at or
 * above PRO_IMPLIED_CENTS_PER_ACTION. That keeps the ladder monotonic: a small
 * shortfall is cheaper to top up, a large one is still cheaper to upgrade.
 *
 * Price a pack below that line and buying top-ups beats upgrading on the pure
 * per-action metric, which is the whole ladder inverting. action-credits_test.ts
 * fails if any pack crosses it.
 */
export const PRO_MONTHLY_CENTS = 5900;
export const PRO_IMPLIED_CENTS_PER_ACTION = PRO_MONTHLY_CENTS / AI_ACTION_LIMITS.pro!;

export const ACTION_CREDIT_PACKS: Record<ActionCreditPackKey, ActionCreditPack> = {
  "50": {
    key: "50",
    credits: 50,
    priceCents: 499,
    priceEnv: "STRIPE_PRICE_ACTION_CREDITS_50",
    appstoreProductId: "com.gradethread.actions.50",
    playProductId: "action_credits_50",
  },
  "150": {
    key: "150",
    credits: 150,
    priceCents: 1399,
    priceEnv: "STRIPE_PRICE_ACTION_CREDITS_150",
    appstoreProductId: "com.gradethread.actions.150",
    playProductId: "action_credits_150",
  },
  "400": {
    key: "400",
    credits: 400,
    priceCents: 3499,
    priceEnv: "STRIPE_PRICE_ACTION_CREDITS_400",
    appstoreProductId: "com.gradethread.actions.400",
    playProductId: "action_credits_400",
  },
  "1000": {
    key: "1000",
    credits: 1000,
    priceCents: 7999,
    priceEnv: "STRIPE_PRICE_ACTION_CREDITS_1000",
    appstoreProductId: "com.gradethread.actions.1000",
    playProductId: "action_credits_1000",
  },
};

export function isActionCreditPackKey(v: unknown): v is ActionCreditPackKey {
  return v === "50" || v === "150" || v === "400" || v === "1000";
}

/** Cents per credit. The number the ladder rule is stated in. */
export function pricePerCredit(pack: ActionCreditPack): number {
  return pack.priceCents / pack.credits;
}

/** The pack a storefront product id belongs to, or null. Fail-closed. */
export function packForAppstoreProductId(productId: string): ActionCreditPack | null {
  return ACTION_CREDIT_PACK_KEYS
    .map((k) => ACTION_CREDIT_PACKS[k])
    .find((p) => p.appstoreProductId === productId) ?? null;
}

export function packForPlayProductId(productId: string): ActionCreditPack | null {
  return ACTION_CREDIT_PACK_KEYS
    .map((k) => ACTION_CREDIT_PACKS[k])
    .find((p) => p.playProductId === productId) ?? null;
}

// ── Low-balance signal ──────────────────────────────────────────────

/**
 * Below this the client nudges. 20 is the smallest pack's usable tail: it is
 * enough warning to buy before a batch stalls, and rare enough that it is not
 * ambient noise for someone who tops up in hundreds.
 */
export const LOW_BALANCE_THRESHOLD = 20;

export function isLowBalance(balance: number): boolean {
  return balance < LOW_BALANCE_THRESHOLD;
}

// ── Wallet access ───────────────────────────────────────────────────
//
// ALWAYS pass the WORKSPACE OWNER's id. AI actions are already billed to the
// owner (US-268), and a member spending their own empty wallet while the
// owner's is funded would be a confusing, silent refusal.

/**
 * Spend credits for one metered action. True when the wallet covered it.
 *
 * Fail-CLOSED: an rpc error logs and reads as "not paid". A broken wallet must
 * never hand out free over-cap actions.
 *
 * NOTE: the AI meter does NOT call this. reserve_ai_action_v2 debits inside its
 * own users-row lock, because a check-then-act pair at that boundary races. This
 * is for meters that have no counter row to lock, which today means the
 * connector.
 */
export async function debitActionCredits(
  ownerId: string,
  meter: ActionMeter,
  notes?: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.rpc("debit_action_credits", {
      p_user_id: ownerId,
      p_credits: creditCostFor(meter),
      p_meter: meter,
      p_notes: notes ?? null,
    });
    if (error) throw new Error(error.message);
    return typeof data === "number" && data >= 0;
  } catch (err) {
    console.error(
      "[action-credits] debit_action_credits failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Return spent credits when the work they paid for failed. */
export async function refundActionCredits(
  ownerId: string,
  meter: ActionMeter,
  notes?: string,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc("refund_action_credits", {
    p_user_id: ownerId,
    p_credits: creditCostFor(meter),
    p_meter: meter,
    p_notes: notes ?? null,
  });
  if (error) {
    console.error("[action-credits] refund_action_credits failed:", error.message);
  }
}

/**
 * The owner's current balance. Returns 0 when the wallet row does not exist
 * (nobody has ever bought a pack), which is the correct reading.
 *
 * THROWS on a real read failure rather than returning 0: a caller deciding
 * whether to offer a top-up must not be told "you have nothing" because the
 * database was briefly unreachable.
 */
export async function readActionCreditBalance(ownerId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("action_credit_wallet")
    .select("balance")
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) throw new Error(`action credit balance unavailable: ${error.message}`);
  return (data as { balance: number } | null)?.balance ?? 0;
}

/** Same read, but a failure reads as 0. For display-only paths. */
export async function readActionCreditBalanceSafe(ownerId: string): Promise<number> {
  try {
    return await readActionCreditBalance(ownerId);
  } catch (err) {
    console.error(
      "[action-credits] balance read failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}
