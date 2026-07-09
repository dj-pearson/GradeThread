// US-1803: the buyer notification delivery layer.
//
// The SINGLE contract the buyer feature epics call — condition alerts (US-1809),
// rewards (US-1814), guarantee (US-1821), portfolio (US-1827) — so none rolls
// its own sender. Fans a buyer notification out across channels, gated by the
// buyer's per-category preference on each channel, DEDUPED via the
// buyer_notification_log idempotency ledger (north-star 00170 pattern: a UNIQUE
// (user_id, dedupe_key) claim makes a repeat/racy call a no-op), and paced by
// the buyer's chosen digest cadence FLOORED by their plan's alertFrequency cap:
//
//   • in-app  — ALWAYS delivered immediately (a passive feed; it's also the
//               content source the digest cron reads).
//   • push    — immediate mode only, gated by the push preference AND quiet
//               hours (push is the intrusive channel).
//   • email   — immediate mode only, gated by the email preference. In
//               daily/weekly mode, the digest cron (phase C) sends one batched
//               email; notifyBuyer sends no email itself.
//
// Best-effort: a channel failure (or APNs/DB unconfigured) NEVER throws — a
// notification problem must not break the feature action that triggered it.
// Deps are injectable so fan-out + gating + idempotency + cadence are
// unit-testable without a DB, APNs, or email (mirrors selling-activity-notify.ts).
//
// TENANT SCOPE (US-268): the caller passes the notification's OWNER userId (the
// authenticated buyer). Every query here is keyed on that id — never a
// request-body value.

import { supabaseAdmin } from "./supabase.ts";
import { notifyUser, type NotificationType, type NotifyInput, PREF_KEY } from "./notify.ts";
import { pushAllowed } from "./selling-activity-notify.ts";
import { type PushPayload, sendPushToUser } from "./apns.ts";
import { sendBuyerNotificationEmail } from "./email.ts";
import { getBuyerEntitlements } from "./buyer-entitlements.ts";
import {
  type BuyerAlertFrequency,
  type BuyerDigestFrequency,
  effectiveDigestMode,
} from "./buyer-plans.ts";

export type BuyerNotificationCategory =
  | "condition_alert"
  | "reward"
  | "guarantee"
  | "portfolio";

// Category → the in-app notification_type enum value (+ its PREF_KEY category).
const CATEGORY_TYPE: Record<BuyerNotificationCategory, NotificationType> = {
  condition_alert: "buyer_condition_alert",
  reward: "buyer_reward",
  guarantee: "buyer_guarantee",
  portfolio: "buyer_portfolio",
};

export interface BuyerNotifyInput {
  category: BuyerNotificationCategory;
  title: string;
  body: string;
  /** In-app deep link within the buyer app, e.g. /buyer/alerts. */
  link?: string | null;
  /**
   * Stable idempotency key. The SAME (userId, dedupeKey) delivers at most once —
   * pick something that identifies the unit of work (e.g. `alert:<alertId>:<listingId>`).
   */
  dedupeKey: string;
  /** Optional structured payload carried on push `data`. */
  data?: Record<string, string>;
}

type ChannelPrefs = Record<string, { push?: boolean; email?: boolean }> | null | undefined;

/** Everything needed to decide how to deliver, loaded once per notification. */
export interface BuyerDeliveryContext {
  prefs: ChannelPrefs;
  email: string | null;
  digestFrequency: BuyerDigestFrequency;
  quietStart: number | null;
  quietEnd: number | null;
  alertFrequency: BuyerAlertFrequency;
}

export interface BuyerNotifyDeps {
  /** Insert the idempotency claim; resolves true if NEWLY claimed (deliver),
   *  false if already handled (skip) or the claim failed (skip, fail-safe). */
  claim: (userId: string, category: string, dedupeKey: string) => Promise<boolean>;
  loadContext: (userId: string) => Promise<BuyerDeliveryContext>;
  notify: (userId: string, input: NotifyInput) => Promise<void>;
  push: (userId: string, payload: PushPayload) => Promise<unknown>;
  sendEmail: (to: string, data: { title: string; body: string; link?: string | null }) => Promise<unknown>;
  /** Injectable clock for quiet-hours (defaults to real time). */
  now: () => Date;
}

// ── Pure helpers (exported for tests) ───────────────────────────────

/** Whether the email channel should fire for a category (default ON). */
export function emailAllowed(prefs: ChannelPrefs, prefKey: string | null): boolean {
  const cat = prefKey ? prefs?.[prefKey] : undefined;
  return cat?.email !== false;
}

/**
 * Is `hour` (0-23, UTC) inside the quiet window [start, end)? Handles wrap-around
 * (e.g. 22→7). Null/equal bounds = no quiet hours. Quiet hours suppress PUSH only.
 */
export function inQuietHours(
  hour: number,
  start: number | null,
  end: number | null,
): boolean {
  if (start == null || end == null || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// ── Default (real) deps ─────────────────────────────────────────────

const defaultClaim = async (
  userId: string,
  category: string,
  dedupeKey: string,
): Promise<boolean> => {
  const { error } = await supabaseAdmin.from("buyer_notification_log").insert({
    user_id: userId,
    category,
    dedupe_key: dedupeKey,
    channels: [],
    sent_at: new Date().toISOString(),
  });
  if (error) {
    if (error.code === "23505") return false; // already handled — idempotent no-op
    console.error(`[buyer-notify] claim failed for ${userId} (${dedupeKey}): ${error.message}`);
    return false;
  }
  return true;
};

const defaultLoadContext = async (userId: string): Promise<BuyerDeliveryContext> => {
  const [userRes, prefRes, ent] = await Promise.all([
    supabaseAdmin.from("users").select("notification_preferences, email").eq("id", userId).maybeSingle(),
    supabaseAdmin
      .from("buyer_preferences")
      .select("digest_frequency, quiet_hours_start, quiet_hours_end")
      .eq("user_id", userId)
      .maybeSingle(),
    getBuyerEntitlements(userId),
  ]);
  const user = userRes.data as { notification_preferences?: ChannelPrefs; email?: string } | null;
  const pref = prefRes.data as
    | { digest_frequency?: BuyerDigestFrequency; quiet_hours_start?: number | null; quiet_hours_end?: number | null }
    | null;
  return {
    prefs: user?.notification_preferences ?? null,
    email: user?.email ?? null,
    digestFrequency: pref?.digest_frequency ?? "immediate",
    quietStart: pref?.quiet_hours_start ?? null,
    quietEnd: pref?.quiet_hours_end ?? null,
    alertFrequency: ent.allowances.alertFrequency,
  };
};

const defaultDeps: BuyerNotifyDeps = {
  claim: defaultClaim,
  loadContext: defaultLoadContext,
  notify: notifyUser,
  push: sendPushToUser,
  sendEmail: (to, data) => sendBuyerNotificationEmail(to, data),
  now: () => new Date(),
};

/**
 * Deliver a buyer notification. In-app always fires; push + email fire only in
 * IMMEDIATE mode (the plan-capped effective cadence) — daily/weekly buyers get a
 * batched digest from the cron (US-1803 phase C) whose content is this in-app
 * notification. Deduped by (userId, dedupeKey). Never throws.
 *
 * Returns true if this call delivered the in-app notification, false if it was a
 * dedupe no-op or a roleless/empty user.
 */
export async function notifyBuyer(
  userId: string,
  input: BuyerNotifyInput,
  deps: BuyerNotifyDeps = defaultDeps,
): Promise<boolean> {
  if (!userId) return false;

  // Idempotency gate FIRST — a repeat/racy call for the same unit of work
  // delivers nothing.
  let claimed = false;
  try {
    claimed = await deps.claim(userId, input.category, input.dedupeKey);
  } catch (err) {
    console.error("[buyer-notify] claim threw:", err instanceof Error ? err.message : err);
    return false;
  }
  if (!claimed) return false;

  const type = CATEGORY_TYPE[input.category];

  // In-app — always (gated inside notifyUser by PREF_KEY, default ON). This is
  // also the content the digest cron reads for daily/weekly buyers.
  try {
    await deps.notify(userId, { type, title: input.title, message: input.body, link: input.link ?? null });
  } catch (err) {
    console.error("[buyer-notify] in-app failed:", err instanceof Error ? err.message : err);
  }

  // Delivery context (prefs + cadence + quiet hours + plan cap + email).
  let ctx: BuyerDeliveryContext;
  try {
    ctx = await deps.loadContext(userId);
  } catch (err) {
    console.error("[buyer-notify] loadContext failed:", err instanceof Error ? err.message : err);
    return true; // in-app already delivered
  }

  // Only immediate mode sends push/email now; daily/weekly defer to the digest.
  const mode = effectiveDigestMode(ctx.digestFrequency, ctx.alertFrequency);
  if (mode !== "immediate") return true;

  const prefKey = PREF_KEY[type];

  // Push — gated by preference AND quiet hours (the intrusive channel).
  if (pushAllowed(ctx.prefs, prefKey) && !inQuietHours(deps.now().getUTCHours(), ctx.quietStart, ctx.quietEnd)) {
    const payload: PushPayload = {
      title: input.title,
      body: input.body,
      category: type,
      data: input.data,
      collapseId: input.dedupeKey,
    };
    try {
      await deps.push(userId, payload);
    } catch (err) {
      console.error("[buyer-notify] push failed:", err instanceof Error ? err.message : err);
    }
  }

  // Email — gated by preference; quiet hours don't suppress a non-intrusive inbox.
  if (ctx.email && emailAllowed(ctx.prefs, prefKey)) {
    try {
      await deps.sendEmail(ctx.email, { title: input.title, body: input.body, link: input.link ?? null });
    } catch (err) {
      console.error("[buyer-notify] email failed:", err instanceof Error ? err.message : err);
    }
  }

  return true;
}
