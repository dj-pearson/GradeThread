// Selling-activity notifications (US-1054): sale recorded / listing live /
// payout imported / item status change, delivered across in-app + push.
//
// These four events were previously half-wired — the notification types and the
// pushSaleCreated()/pushPayoutCleared() helpers existed, but in-app and push were
// fired separately and push ignored the user's per-category preference. This
// module is the single delivery point so every event source fans out the same
// way, gated by the user's preferences on each channel:
//   • in-app — gated inside notifyUser() by PREF_KEY (default ON).
//   • push   — gated here by pushAllowed() against notification_preferences
//              (default ON), and only sale_recorded / payout_imported carry a
//              push (the iOS app defines no category for listing-live / status).
//
// Best-effort across the board: a channel failure (or APNs/DB simply being
// unconfigured) NEVER throws — a notification problem must not break the
// lifecycle action (sync, publish, payout ingest) that triggered it. Call as
// `void notifyX(...)`.
//
// Delivery deps are injectable so the fan-out + preference gating is unit-testable
// without a DB or APNs (mirrors marketplace-event-notify.ts).

import { supabaseAdmin } from "./supabase.ts";
import { notifyUser, type NotifyInput, PREF_KEY } from "./notify.ts";
import { pushPayoutCleared, pushSaleCreated } from "./transactional-push.ts";

const ITEM_LINK = (itemId: string) => `/dashboard/flipdesk/items/${itemId}`;
const RECONCILIATION_LINK = "/dashboard/flipdesk/reconciliation";

// ── Preference gating (pure) ────────────────────────────────────────

type PushPrefs = Record<string, { push?: boolean }> | null | undefined;

/**
 * Whether the push channel should fire for a category, given the user's prefs.
 * Default ON — only an explicit `false` suppresses push. A `null` prefKey
 * (always-on type) always allows. Pure; exported for gating tests.
 */
export function pushAllowed(prefs: PushPrefs, prefKey: string | null): boolean {
  const cat = prefKey ? prefs?.[prefKey] : undefined;
  return cat?.push !== false;
}

// ── Content builders (pure) ─────────────────────────────────────────

export function buildSaleRecorded(opts: {
  itemTitle: string | null;
  price: number | null;
  itemId: string;
}): NotifyInput {
  const title = opts.itemTitle?.trim() || "An item";
  const amount = opts.price != null && Number.isFinite(opts.price)
    ? ` for $${opts.price.toFixed(2)}`
    : "";
  return {
    type: "sale_recorded",
    title: "Item sold",
    message: `${title} sold${amount}.`,
    link: ITEM_LINK(opts.itemId),
  };
}

export function buildListingLive(opts: {
  itemTitle: string | null;
  itemId: string;
}): NotifyInput {
  return {
    type: "listing_live",
    title: "Listing is live",
    message: `${opts.itemTitle?.trim() || "Your item"} is now listed on eBay.`,
    link: ITEM_LINK(opts.itemId),
  };
}

export function buildListingEnded(opts: {
  itemTitle: string | null;
  itemId: string;
}): NotifyInput {
  return {
    type: "item_status_change",
    title: "Listing ended",
    message:
      `${opts.itemTitle?.trim() || "Your item"} ended on eBay without selling — it's back in Drafts to edit and relist.`,
    link: ITEM_LINK(opts.itemId),
  };
}

export function buildPayoutImported(opts: {
  count: number;
  currency?: string | null;
  amount?: number | null;
}): NotifyInput {
  // A single payout with a known amount gets a precise message; a batch
  // (CSV upload) falls back to a count-based one.
  let message: string;
  if (opts.count === 1 && opts.amount != null && Number.isFinite(opts.amount)) {
    message = `A ${opts.currency ?? "USD"} ${opts.amount} payout was imported from eBay.`;
  } else {
    message = `${opts.count} payouts were imported from eBay.`;
  }
  return {
    type: "payout_imported",
    title: "Payout received",
    message,
    link: RECONCILIATION_LINK,
  };
}

// ── Cross-channel delivery ──────────────────────────────────────────

export interface SellingActivityDeps {
  loadPrefs: (userId: string) => Promise<PushPrefs>;
  notify: (userId: string, input: NotifyInput) => Promise<void>;
  // Optional test interceptor: when set, called (still preference-gated)
  // INSTEAD of the real APNs sender, so a unit test can assert push fired
  // without touching APNs.
  onPush?: (userId: string) => void | Promise<void>;
}

const defaultLoadPrefs = async (userId: string): Promise<PushPrefs> => {
  const { data } = await supabaseAdmin
    .from("users")
    .select("notification_preferences")
    .eq("id", userId)
    .maybeSingle();
  return (
    data as { notification_preferences?: PushPrefs } | null
  )?.notification_preferences ?? null;
};

const defaultDeps: SellingActivityDeps = {
  loadPrefs: defaultLoadPrefs,
  notify: notifyUser,
};

// One delivery plan: the in-app payload plus an optional push sender. Push is
// only invoked when the user's category preference allows it.
interface ChannelPlan {
  inApp: NotifyInput;
  push?: (userId: string) => Promise<unknown> | void;
}

// Fan a plan out to in-app + (optional) push, gating push by the user's
// per-category preference (default ON). The in-app leg is gated inside
// notifyUser by PREF_KEY. Best-effort across the board — never throws.
async function deliver(
  userId: string,
  plan: ChannelPlan,
  deps: SellingActivityDeps,
): Promise<void> {
  if (!userId) return;
  try {
    await deps.notify(userId, plan.inApp);
  } catch (err) {
    console.error(
      "[selling-activity] in-app failed:",
      err instanceof Error ? err.message : err,
    );
  }

  if (!plan.push) return;

  let prefs: PushPrefs = null;
  try {
    prefs = await deps.loadPrefs(userId);
  } catch (err) {
    console.error(
      "[selling-activity] loadPrefs failed:",
      err instanceof Error ? err.message : err,
    );
  }
  if (!pushAllowed(prefs, PREF_KEY[plan.inApp.type])) return;

  try {
    if (deps.onPush) await deps.onPush(userId);
    else await plan.push(userId);
  } catch (err) {
    console.error(
      "[selling-activity] push failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Public emitters (deliver across channels) ───────────────────────

/** A brand-new completed sale was ingested from a marketplace sync. */
export function notifySaleRecorded(
  userId: string,
  opts: { itemTitle: string | null; price: number | null; itemId: string },
  deps: SellingActivityDeps = defaultDeps,
): Promise<void> {
  return deliver(userId, {
    inApp: buildSaleRecorded(opts),
    push: (uid) => pushSaleCreated(uid, opts.itemTitle),
  }, deps);
}

/** A listing transitioned to live on a marketplace. In-app only. */
export function notifyListingLive(
  userId: string,
  opts: { itemTitle: string | null; itemId: string },
  deps: SellingActivityDeps = defaultDeps,
): Promise<void> {
  return deliver(userId, { inApp: buildListingLive(opts) }, deps);
}

/** A listing ended without selling and returned to drafts. In-app only. */
export function notifyListingEnded(
  userId: string,
  opts: { itemTitle: string | null; itemId: string },
  deps: SellingActivityDeps = defaultDeps,
): Promise<void> {
  return deliver(userId, { inApp: buildListingEnded(opts) }, deps);
}

/** One or more payouts were imported (webhook sync or CSV upload). */
export function notifyPayoutImported(
  userId: string,
  opts: { count: number; currency?: string | null; amount?: number | null },
  deps: SellingActivityDeps = defaultDeps,
): Promise<void> {
  return deliver(userId, {
    inApp: buildPayoutImported(opts),
    push: (uid) => pushPayoutCleared(uid, opts.count),
  }, deps);
}
