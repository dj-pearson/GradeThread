#!/usr/bin/env -S npx tsx
/**
 * One-off backfill: reconcile every user's FlipDesk subscription state against
 * the actual Stripe subscription (US-225).
 *
 * Migration 00039_pricing_migrate_existing.sql does the cheap, deterministic
 * part — mapping the legacy `users.plan` enum onto `flipdesk_plan` and setting
 * `subscription_status` to a coarse 'none'/'active' based on whether a Stripe
 * customer exists. That mapping can drift from reality (a customer whose card
 * lapsed is 'past_due' in Stripe but 'active' in our column; a yearly sub shows
 * as monthly; period_end is stale). This script fetches the live Stripe
 * subscription for every user with a stripe_customer_id and reconciles:
 *
 *     subscription_status · flipdesk_subscription_id · flipdesk_period_end
 *     · flipdesk_interval · flipdesk_plan
 *
 * It NEVER cancels and re-creates subscriptions. Existing subs are left as-is;
 * we only correct our own database to match Stripe. The one Stripe-side change
 * the AC permits — swapping a subscription's price when the legacy SKU maps to a
 * new plan — is gated:
 *   • same amount (e.g. legacy Starter $29 → FlipDesk Starter $29): no-op.
 *   • different amount (e.g. legacy Professional $99 → Business $99 vs Pro $59):
 *     FLAGGED for manual admin review and NOT applied, even with --apply.
 *
 * Modes:
 *   (default)  dry-run — prints the full mapping table, writes nothing.
 *   --apply    execute the DB reconciliation (safe, idempotent).
 *   --live     require a live Stripe key (guards against pointing at prod by
 *              accident with a test key, or vice-versa).
 *
 * Env:
 *   STRIPE_SECRET_KEY            sk_test_… or sk_live_…
 *   SUPABASE_URL                 https://api.gradethread.com
 *   SUPABASE_SERVICE_ROLE_KEY    (or SUPABASE_SERVICE_KEY)
 *
 * Run:
 *   STRIPE_SECRET_KEY=sk_test_… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     npx tsx scripts/backfill-stripe-state.ts            # dry-run
 *   … npx tsx scripts/backfill-stripe-state.ts --apply    # execute
 */

import { createClient } from "@supabase/supabase-js";

// ── Config / flags ────────────────────────────────────────────────
const APPLY = process.argv.includes("--apply");
const LIVE = process.argv.includes("--live");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_KEY ??
  "";

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!STRIPE_SECRET_KEY) die("STRIPE_SECRET_KEY is required");
if (!SUPABASE_URL) die("SUPABASE_URL is required");
if (!SUPABASE_SERVICE_KEY) {
  die("SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) is required");
}
if (LIVE && !STRIPE_SECRET_KEY.startsWith("sk_live_")) {
  die("--live set but STRIPE_SECRET_KEY is not a live key");
}
if (!LIVE && STRIPE_SECRET_KEY.startsWith("sk_live_")) {
  die("STRIPE_SECRET_KEY is a live key but --live was not passed");
}

const STRIPE = "https://api.stripe.com/v1";

// ── Stripe REST helper (no SDK — mirrors setup-stripe-pricing.mjs) ─
async function stripe<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${STRIPE}${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// ── Plan / interval / status derivation (mirrors webhooks.ts) ─────
type FlipdeskPlan = "free" | "starter" | "pro" | "business";
type Interval = "monthly" | "yearly";
type SubStatus =
  | "none"
  | "trialing"
  | "active"
  | "past_due"
  | "paused"
  | "canceled";

interface StripePrice {
  id: string;
  unit_amount: number | null;
  lookup_key: string | null;
  recurring: { interval: string } | null;
}
interface StripeSubscription {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: number | null;
  pause_collection: { resumes_at: number | null } | null;
  metadata: Record<string, string> | null;
  items: { data: Array<{ price: StripePrice }> };
}

function planFromSub(sub: StripeSubscription): FlipdeskPlan {
  const meta = sub.metadata?.plan;
  if (meta === "starter" || meta === "pro" || meta === "business") return meta;
  const price = sub.items?.data?.[0]?.price;
  const lk = price?.lookup_key ?? "";
  if (lk.startsWith("flipdesk_business")) return "business";
  if (lk.startsWith("flipdesk_pro")) return "pro";
  if (lk.startsWith("flipdesk_starter")) return "starter";
  const amount = price?.unit_amount ?? 0;
  if (amount >= 9900) return "business";
  if (amount >= 5900) return "pro";
  if (amount >= 2900) return "starter";
  return "starter";
}

function intervalFromSub(sub: StripeSubscription): Interval {
  return sub.items?.data?.[0]?.price?.recurring?.interval === "year"
    ? "yearly"
    : "monthly";
}

function statusFromSub(sub: StripeSubscription): SubStatus {
  if (sub.pause_collection) return "paused";
  switch (sub.status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "active";
  }
}

// Pick the subscription that best represents the customer's current paid state:
// prefer active/trialing/past_due/paused over canceled/incomplete.
function pickPrimary(subs: StripeSubscription[]): StripeSubscription | null {
  const rank: Record<string, number> = {
    active: 5,
    trialing: 5,
    past_due: 4,
    paused: 4,
    unpaid: 3,
    incomplete: 2,
    canceled: 1,
    incomplete_expired: 0,
  };
  return (
    [...subs].sort((a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0))[0] ??
    null
  );
}

// ── Main ──────────────────────────────────────────────────────────
interface UserRow {
  id: string;
  email: string | null;
  plan: string | null; // legacy column
  flipdesk_plan: FlipdeskPlan | null;
  flipdesk_interval: Interval | null;
  subscription_status: SubStatus | null;
  flipdesk_subscription_id: string | null;
  flipdesk_period_end: string | null;
  stripe_customer_id: string;
}

interface Diff {
  user: UserRow;
  desired: {
    flipdesk_plan: FlipdeskPlan;
    flipdesk_interval: Interval;
    subscription_status: SubStatus;
    flipdesk_subscription_id: string | null;
    flipdesk_period_end: string | null;
  };
  changes: string[];
  priceReviewNote?: string;
}

async function main() {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(
    `\n${APPLY ? "APPLY" : "DRY-RUN"} · Stripe ${LIVE ? "LIVE" : "TEST"} mode\n` +
      "Reconciling FlipDesk subscription state against Stripe…\n",
  );

  // Page through every user with a Stripe customer.
  const PAGE = 500;
  let from = 0;
  const diffs: Diff[] = [];
  let scanned = 0;
  let noSub = 0;

  for (;;) {
    const { data, error } = await sb
      .from("users")
      .select(
        "id, email, plan, flipdesk_plan, flipdesk_interval, subscription_status, " +
          "flipdesk_subscription_id, flipdesk_period_end, stripe_customer_id",
      )
      .not("stripe_customer_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) die(`Supabase query failed: ${error.message}`);
    const rows = (data ?? []) as unknown as UserRow[];
    if (rows.length === 0) break;

    for (const user of rows) {
      scanned++;
      let subs: StripeSubscription[];
      try {
        const resp = await stripe<{ data: StripeSubscription[] }>(
          `/subscriptions?customer=${user.stripe_customer_id}&status=all&limit=100`,
        );
        subs = resp.data;
      } catch (err) {
        console.error(
          `  ! ${user.email ?? user.id}: Stripe fetch failed — ${(err as Error).message}`,
        );
        continue;
      }

      const primary = pickPrimary(subs);
      if (!primary) {
        // Customer exists but has no subscription — they're effectively Free.
        noSub++;
        const desired = {
          flipdesk_plan: "free" as FlipdeskPlan,
          flipdesk_interval: (user.flipdesk_interval ?? "monthly") as Interval,
          subscription_status: "none" as SubStatus,
          flipdesk_subscription_id: null,
          flipdesk_period_end: null,
        };
        const changes = collectChanges(user, desired);
        if (changes.length) diffs.push({ user, desired, changes });
        continue;
      }

      const desired = {
        flipdesk_plan: planFromSub(primary),
        flipdesk_interval: intervalFromSub(primary),
        subscription_status: statusFromSub(primary),
        flipdesk_subscription_id: primary.id,
        flipdesk_period_end: primary.current_period_end
          ? new Date(primary.current_period_end * 1000).toISOString()
          : null,
      };

      // Price-drift review: legacy plan whose Stripe amount maps to a different
      // FlipDesk plan AND a different price point → don't auto-swap, flag it.
      const amount = primary.items?.data?.[0]?.price?.unit_amount ?? 0;
      let priceReviewNote: string | undefined;
      if (
        user.plan === "professional" &&
        amount === 9900 &&
        desired.flipdesk_plan === "business"
      ) {
        priceReviewNote =
          "legacy 'professional' @ $99 → Business @ $99 (NOT Pro @ $59); confirm plan choice before any price swap";
      }

      const changes = collectChanges(user, desired);
      if (changes.length || priceReviewNote) {
        diffs.push({ user, desired, changes, priceReviewNote });
      }
    }

    if (rows.length < PAGE) break;
    from += PAGE;
  }

  // ── Report ─────────────────────────────────────────────────────
  console.log(
    `Scanned ${scanned} customers · ${noSub} with no live subscription · ` +
      `${diffs.length} need reconciliation\n`,
  );

  for (const d of diffs) {
    console.log(`• ${d.user.email ?? d.user.id}`);
    for (const ch of d.changes) console.log(`    ${ch}`);
    if (d.priceReviewNote) {
      console.log(`    ⚠ MANUAL REVIEW: ${d.priceReviewNote}`);
    }
  }

  if (!APPLY) {
    console.log(
      `\nDry-run complete. Re-run with --apply to write ${diffs.length} ` +
        "reconciliation(s). No Stripe subscriptions are modified.\n",
    );
    return;
  }

  // ── Apply ──────────────────────────────────────────────────────
  let updated = 0;
  for (const d of diffs) {
    const { error } = await sb
      .from("users")
      .update({
        flipdesk_plan: d.desired.flipdesk_plan,
        flipdesk_interval: d.desired.flipdesk_interval,
        subscription_status: d.desired.subscription_status,
        flipdesk_subscription_id: d.desired.flipdesk_subscription_id,
        flipdesk_period_end: d.desired.flipdesk_period_end,
      })
      .eq("id", d.user.id);
    if (error) {
      console.error(`  ! ${d.user.email ?? d.user.id}: update failed — ${error.message}`);
      continue;
    }
    updated++;
  }
  console.log(`\nApplied ${updated}/${diffs.length} reconciliation(s).\n`);
}

function collectChanges(
  user: UserRow,
  desired: Diff["desired"],
): string[] {
  const out: string[] = [];
  const cmp = (label: string, was: unknown, now: unknown) => {
    if ((was ?? null) !== (now ?? null)) out.push(`${label}: ${was ?? "∅"} → ${now ?? "∅"}`);
  };
  cmp("plan", user.flipdesk_plan, desired.flipdesk_plan);
  cmp("interval", user.flipdesk_interval, desired.flipdesk_interval);
  cmp("status", user.subscription_status, desired.subscription_status);
  cmp("sub_id", user.flipdesk_subscription_id, desired.flipdesk_subscription_id);
  cmp("period_end", user.flipdesk_period_end, desired.flipdesk_period_end);
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
