// Marketplace offer / return / cancellation / dispute notifications across all
// channels (US-1055).
//
// These five events are time-sensitive and were previously silent:
//   • offer_received   — a buyer sent a best offer on a listing.
//   • offer_responded  — that offer was accepted / declined / countered.
//   • return_opened    — a buyer opened a return (Post-Order API).
//   • dispute_opened   — a payment dispute / chargeback was opened (the seller
//                        must respond before eBay's respondByDate).
//   • cancellation_requested — a buyer asked to cancel before the order ships
//                        (US-2560). searchCancellations() had existed since the
//                        Post-sale page shipped and NO poll source read it, so
//                        this was the one post-order case a seller could only
//                        learn about by opening the page and looking.
//
// Two concerns live here:
//   1. claimMarketplaceEvent — the idempotency primitive. The poll re-fetches the
//      same open offers/returns/disputes every tick, so we claim a row in
//      marketplace_event_notifications BEFORE delivering; a unique-violation means
//      "already notified" → skip. Fail-CLOSED on any other DB error (skip rather
//      than risk re-notifying the same event on every poll).
//   2. deliverMarketplaceNotification — fans one event out to in-app + email +
//      push, honoring the user's per-category channel preferences. Best-effort:
//      a channel failure never throws.
//
// Delivery deps are injectable so the cross-channel fan-out + preference gating
// is unit-testable without a DB, SMTP, or APNs (mirrors plan-change-notify.ts).

import { supabaseAdmin } from "./supabase.ts";
import { notifyUser, type NotifyInput, PREF_KEY } from "./notify.ts";
import {
  sendCancellationRequestedEmail,
  sendCaseOpenedEmail,
  sendDisputeOpenedEmail,
  sendInquiryOpenedEmail,
  sendPostSaleDeadlineEmail,
  sendOfferReceivedEmail,
  sendOfferRespondedEmail,
  sendReturnOpenedEmail,
} from "./email.ts";
import {
  pushCancellationRequested,
  pushCaseOpened,
  pushDisputeOpened,
  pushInquiryOpened,
  pushPostSaleDeadline,
  pushOfferReceived,
  pushOfferResponded,
  pushReturnOpened,
} from "./transactional-push.ts";

// US-2560 added "cancellation". `source_kind` is a TEXT column (00247), not an
// enum, so widening this union needs no migration — the enum that does is
// notification_type, and that is 00601.
// US-2928/US-2929 add "inquiry" and "case". `source_kind` is a TEXT column
// (00247), so widening this union needs no migration — and it is what keeps the
// dedupe distinct even though both events reuse the `return_opened`
// notification TYPE (see buildInquiryOpened for why).
export type MarketplaceEventKind =
  | "offer"
  | "return"
  | "dispute"
  | "cancellation"
  | "inquiry"
  | "case";

// ── Idempotency ─────────────────────────────────────────────────────

/**
 * Claim a (user, kind, externalId, status) marketplace event. Returns true when
 * this is the FIRST time we've seen it (insert succeeded) → the caller should
 * deliver. Returns false on a duplicate (23505) or any other error (fail-closed:
 * a transient failure must not let the next poll re-notify).
 *
 * US-2156: `itemExternalId` is the marketplace-side item id the event happened
 * on (00508). It is NOT part of the dedup key — it rides along so the ledger can
 * answer "did this listing get an offer this week?" for the automation
 * evaluator. Optional so callers that genuinely have no item (disputes are keyed
 * to an order) stay honest about it.
 */
export async function claimMarketplaceEvent(
  userId: string,
  kind: MarketplaceEventKind,
  externalId: string,
  status: string,
  notificationType: string,
  itemExternalId?: string | null,
): Promise<boolean> {
  if (!userId || !externalId) return false;
  try {
    const { error } = await supabaseAdmin
      .from("marketplace_event_notifications")
      .insert({
        user_id: userId,
        source_kind: kind,
        external_id: externalId,
        status,
        notification_type: notificationType,
        item_external_id: itemExternalId ?? null,
      });
    if (!error) return true;
    if (error.code === "23505") return false; // already notified — expected
    console.error(
      `[marketplace-notify] claim failed for ${userId} ${kind}:${externalId} (${status}): ${error.message}`,
    );
    return false;
  } catch (err) {
    console.error(
      `[marketplace-notify] claim threw for ${userId} ${kind}:${externalId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Give a claim back, so the next poll can try the notification again.
 *
 * US-2319 AC3: the claim exists to stop two runs notifying the same offer at
 * once. It was also, accidentally, stopping the SAME run from ever retrying —
 * the row was inserted before the notification was sent, and a send that threw
 * left the claim standing. The next poll re-read the offer, got 23505, read it
 * as "already notified", and moved on. Forever.
 *
 * The seller's loss is the whole point: a best offer expires in 48 hours, and
 * an offer nobody was told about expires unanswered. Nothing anywhere reports
 * that — the poll returns a clean result and the claim row looks exactly like a
 * notification that succeeded.
 *
 * So the shape is claim → work → release-on-failure. A claim prevents a
 * duplicate WHILE the work runs, not forever after it failed.
 *
 * Best-effort by design: if the release itself fails we are back to the old
 * behaviour for that one event, which is where we started and no worse.
 */
export async function releaseMarketplaceEvent(
  userId: string,
  kind: MarketplaceEventKind,
  externalId: string,
  status: string,
): Promise<void> {
  if (!userId || !externalId) return;
  try {
    const { error } = await supabaseAdmin
      .from("marketplace_event_notifications")
      .delete()
      .eq("user_id", userId)
      .eq("source_kind", kind)
      .eq("external_id", externalId)
      .eq("status", status);
    if (error) {
      console.error(
        `[marketplace-notify] release failed for ${userId} ${kind}:${externalId} (${status}): ${error.message}`,
      );
    }
  } catch (err) {
    console.error(
      `[marketplace-notify] release threw for ${userId} ${kind}:${externalId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Cross-channel delivery ──────────────────────────────────────────

interface UserContact {
  email: string | null;
  fullName: string | null;
  prefs: Record<string, { email?: boolean; push?: boolean }> | null;
}

export interface MarketplaceNotifyDeps {
  loadContact: (userId: string) => Promise<UserContact | null>;
  notify: (userId: string, input: NotifyInput) => Promise<void>;
  // Optional test interceptors: when set, called (still preference-gated)
  // INSTEAD of the plan's real email/push sender, so a unit test can assert
  // which channels fired without touching SMTP/APNs.
  onEmail?: (userId: string) => void | Promise<void>;
  onPush?: (userId: string) => void | Promise<void>;
}

/**
 * Whether email/push should be delivered for a category, given the user's prefs.
 * Default ON — only an explicit `false` suppresses a channel. Pure; exported for
 * preference-gating tests.
 */
export function channelAllows(
  prefs: Record<string, { email?: boolean; push?: boolean }> | null | undefined,
  prefKey: string | null,
): { email: boolean; push: boolean } {
  const cat = prefKey ? prefs?.[prefKey] : undefined;
  return { email: cat?.email !== false, push: cat?.push !== false };
}

const defaultLoadContact = async (userId: string): Promise<UserContact | null> => {
  const { data } = await supabaseAdmin
    .from("users")
    .select("email, full_name, notification_preferences")
    .eq("id", userId)
    .maybeSingle();
  const row = data as
    | {
        email: string | null;
        full_name: string | null;
        notification_preferences:
          | Record<string, { email?: boolean; push?: boolean }>
          | null;
      }
    | null;
  if (!row) return null;
  return { email: row.email, fullName: row.full_name, prefs: row.notification_preferences };
};

const defaultDeps: MarketplaceNotifyDeps = {
  loadContact: defaultLoadContact,
  notify: notifyUser,
};

// One delivery plan: the in-app payload plus per-channel senders. email/push are
// only invoked when the user's category preference allows that channel.
interface ChannelPlan {
  inApp: NotifyInput;
  email: (to: string, userName: string) => Promise<unknown>;
  push: (userId: string) => Promise<unknown>;
}

// Fan a plan out to in-app + email + push, gating email/push by the user's
// per-category preference (default ON). The in-app leg is gated inside
// notifyUser by PREF_KEY. Best-effort across the board — never throws.
async function deliver(
  userId: string,
  plan: ChannelPlan,
  deps: MarketplaceNotifyDeps,
): Promise<void> {
  const prefKey = PREF_KEY[plan.inApp.type];
  try {
    await deps.notify(userId, plan.inApp);
  } catch (err) {
    console.error("[marketplace-notify] in-app failed:", err instanceof Error ? err.message : err);
  }

  let contact: UserContact | null = null;
  try {
    contact = await deps.loadContact(userId);
  } catch (err) {
    console.error("[marketplace-notify] loadContact failed:", err instanceof Error ? err.message : err);
  }
  const allow = channelAllows(contact?.prefs, prefKey);

  if (contact?.email && allow.email) {
    try {
      if (deps.onEmail) await deps.onEmail(userId);
      else await plan.email(contact.email, contact.fullName ?? "there");
    } catch (err) {
      console.error("[marketplace-notify] email failed:", err instanceof Error ? err.message : err);
    }
  }
  if (allow.push) {
    try {
      if (deps.onPush) await deps.onPush(userId);
      else await plan.push(userId);
    } catch (err) {
      console.error("[marketplace-notify] push failed:", err instanceof Error ? err.message : err);
    }
  }
}

// ── Formatting + content builders (pure) ────────────────────────────

export function formatMoney(value: number | null, currency: string | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const cur = currency ?? "USD";
  const symbol = cur === "USD" ? "$" : `${cur} `;
  return `${symbol}${value.toFixed(2)}`;
}

const OFFERS_LINK = "/dashboard/flipdesk/offers";
const POST_SALE_LINK = "/dashboard/flipdesk/post-sale";

export interface OfferReceivedEvent {
  userId: string;
  bestOfferId: string;
  itemTitle: string | null;
  price: number | null;
  currency: string | null;
  buyerUsername: string | null;
  expiresAt: string | null;
}

/** Build the in-app payload for an offer-received event (pure; exported for tests). */
export function buildOfferReceived(ev: OfferReceivedEvent): NotifyInput {
  const title = ev.itemTitle?.trim() || "your listing";
  const amount = formatMoney(ev.price, ev.currency);
  const who = ev.buyerUsername?.trim() || "A buyer";
  const amountPhrase = amount ? ` of ${amount}` : "";
  return {
    type: "offer_received",
    title: "New offer",
    message: `${who} sent an offer${amountPhrase} on ${title}.`,
    link: OFFERS_LINK,
  };
}

/**
 * US-2699: a sold-sync confirmed sale, and what it pulled down elsewhere.
 *
 * WHY THE SIBLINGS ARE NAMED RATHER THAN COUNTED. This notification is the only
 * moment a seller learns that GradeThread ended listings on their behalf, on
 * channels they were not looking at, because of a row the extension read off a
 * page. A seller who disagrees has to be able to find that out NOW, while the
 * listing can be re-posted, rather than next week when they notice it missing.
 * "We also ended 3 listings" does not let them check; naming eBay and Mercari
 * does.
 *
 * Reuses the existing sale_recorded type deliberately. It is a sale being
 * recorded, the pref category is already right, and a new type would mean a
 * migration to widen a CHECK for a distinction the seller does not care about.
 *
 * Pure, so the wording is testable and so the "named, not counted" rule is held
 * by a test rather than by this comment.
 */
export interface SyncSaleEvent {
  itemTitle: string | null;
  /** Where it sold. */
  platform: string;
  /** Channels whose sibling listing was ended or queued for ending. */
  delistedOn: readonly string[];
  /** Channels we could NOT end, which is the seller's job and must be said. */
  manualOn: readonly string[];
}

function labelPlatform(p: string): string {
  const key = String(p || "").toLowerCase();
  const LABELS: Record<string, string> = {
    ebay: "eBay",
    poshmark: "Poshmark",
    mercari: "Mercari",
    grailed: "Grailed",
    vinted: "Vinted",
    facebook: "Facebook",
    depop: "Depop",
    etsy: "Etsy",
    shopify: "Shopify",
    whatnot: "Whatnot",
  };
  return LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "another channel");
}

/** Join a list the way a person writes one: "eBay and Mercari", "a, b and c". */
function humanJoin(items: readonly string[]): string {
  const list = items.map(labelPlatform);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  return list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
}

export function buildSyncSaleRecorded(ev: SyncSaleEvent): NotifyInput {
  const title = ev.itemTitle?.trim() || "your listing";
  const where = labelPlatform(ev.platform);

  const parts = [`${title} sold on ${where}.`];
  if (ev.delistedOn.length > 0) {
    parts.push(`GradeThread ended it on ${humanJoin(ev.delistedOn)}.`);
  }
  if (ev.manualOn.length > 0) {
    // Grailed is the standing case: its delete is confirmed by a native browser
    // dialog nothing in a page can answer, so a Grailed sibling is always the
    // seller's job. Saying nothing here is how the same garment sells twice.
    parts.push(`End it yourself on ${humanJoin(ev.manualOn)} — we cannot do that one for you.`);
  }
  if (ev.delistedOn.length === 0 && ev.manualOn.length === 0) {
    parts.push("Nothing was live elsewhere.");
  }

  return {
    type: "sale_recorded",
    title: "Sold, synced from your browser",
    message: parts.join(" "),
    link: POST_SALE_LINK,
  };
}

export type OfferAction = "accepted" | "declined" | "countered";

export function buildOfferResponded(itemTitle: string | null, action: OfferAction): NotifyInput {
  const title = itemTitle?.trim() || "your listing";
  return {
    type: "offer_responded",
    title: `Offer ${action}`,
    message: `The offer on ${title} was ${action}.`,
    link: OFFERS_LINK,
  };
}

export interface ReturnOpenedEvent {
  userId: string;
  returnId: string;
  itemLabel: string | null;
  reason: string | null;
}

export function buildReturnOpened(ev: ReturnOpenedEvent): NotifyInput {
  const label = ev.itemLabel?.trim() || "an order";
  const reason = ev.reason?.trim();
  return {
    type: "return_opened",
    title: "Return opened",
    message: reason
      ? `A buyer opened a return on ${label} (${reason}). Respond before eBay's deadline.`
      : `A buyer opened a return on ${label}. Respond before eBay's deadline.`,
    link: POST_SALE_LINK,
  };
}

export interface InquiryOpenedEvent {
  userId: string;
  inquiryId: string;
  orderLabel: string | null;
  reason: string | null;
  respondBy: string | null;
}

/**
 * US-2928: an Item Not Received inquiry.
 *
 * THE TYPE IS `return_opened` AND THAT IS DELIBERATE. `notification_type` is a
 * Postgres enum (00601), so a distinct in-app type would need an ALTER TYPE and
 * the deploy-order care that comes with it — for a value whose only job is to
 * pick a preference category. The right category IS the returns one: a seller
 * who muted post-sale notices meant this too. The title, message and link are
 * what the seller reads, and all three are specific to an inquiry. The email
 * and push categories ARE distinct, so nothing downstream conflates them.
 */
export function buildInquiryOpened(ev: InquiryOpenedEvent): NotifyInput {
  const order = ev.orderLabel?.trim() || "an order";
  const reason = ev.reason?.trim().replace(/_/g, " ").toLowerCase();
  const deadline = ev.respondBy ? ` Respond by ${ev.respondBy.slice(0, 10)}.` : "";
  return {
    type: "return_opened",
    title: "Item not received",
    message: reason
      ? `A buyer says ${order} never arrived (${reason}). Add tracking before it escalates.${deadline}`
      : `A buyer says ${order} never arrived. Add tracking before it escalates.${deadline}`,
    link: POST_SALE_LINK,
  };
}

export interface CaseOpenedEvent {
  userId: string;
  caseId: string;
  orderLabel: string | null;
  reason: string | null;
  respondBy: string | null;
}

/** US-2929: the escalation. Same type-reuse rationale as buildInquiryOpened. */
export function buildCaseOpened(ev: CaseOpenedEvent): NotifyInput {
  const order = ev.orderLabel?.trim() || "an order";
  const reason = ev.reason?.trim().replace(/_/g, " ").toLowerCase();
  const deadline = ev.respondBy
    ? ` Respond by ${ev.respondBy.slice(0, 10)} or eBay decides without you.`
    : "";
  return {
    type: "return_opened",
    title: "eBay case opened",
    message: reason
      ? `A buyer escalated ${order} to eBay (${reason}). A case decided against you is a defect.${deadline}`
      : `A buyer escalated ${order} to eBay. A case decided against you is a defect.${deadline}`,
    link: POST_SALE_LINK,
  };
}

export interface OfferCandidateDigestEvent {
  userId: string;
  /** How many items are worth an offer today, after the cooldown. */
  count: number;
  /** The watcher total across them — the reach the discount would buy. */
  watchers: number;
}

/**
 * US-2943: the morning nudge.
 *
 * ONCE A DAY AND ONLY WHEN THERE IS SOMETHING TO SAY. A digest that arrives
 * every morning saying "0 items" is a digest people mute in a week, and a muted
 * channel takes the deadline reminders with it.
 *
 * Reuses the `offer_received` type for the same reason the post-sale additions
 * reuse `return_opened`: notification_type is a Postgres enum, and the right
 * preference category IS offers — a seller who muted offer notices meant this.
 */
export function buildOfferCandidateDigest(ev: OfferCandidateDigestEvent): NotifyInput {
  return {
    type: "offer_received",
    title: "Watchers worth an offer today",
    message: `${ev.count} item${ev.count === 1 ? "" : "s"} ${
      ev.count === 1 ? "has" : "have"
    } watchers who have not bought yet` +
      `${ev.watchers > 0 ? ` — ${ev.watchers} watcher${ev.watchers === 1 ? "" : "s"} in total` : ""}.`,
    link: OFFERS_LINK,
  };
}

export interface CaseDeadlineEvent {
  userId: string;
  caseType: "return" | "cancellation" | "payment_dispute" | "inquiry" | "case";
  externalId: string;
  orderLabel: string | null;
  reason: string | null;
  respondBy: string | null;
  tier: "48h" | "12h";
  amountCents: number | null;
  currency: string | null;
}

/** What to call each case type in a sentence a seller reads at speed. */
const CASE_LABEL: Record<CaseDeadlineEvent["caseType"], string> = {
  return: "return",
  cancellation: "cancellation request",
  payment_dispute: "payment dispute",
  inquiry: "item-not-received inquiry",
  case: "eBay case",
};

export function caseLabelFor(caseType: CaseDeadlineEvent["caseType"]): string {
  return CASE_LABEL[caseType];
}

/**
 * US-2933: the deadline is close.
 *
 * Same `return_opened` type reuse as the other two post-sale additions — the
 * preference category a seller would mute for this is the returns one, and a
 * distinct value would mean an enum migration for a routing key nobody reads.
 * What the seller sees is the title and message, and both name the case type.
 */
export function buildCaseDeadline(ev: CaseDeadlineEvent): NotifyInput {
  const label = caseLabelFor(ev.caseType);
  const order = ev.orderLabel?.trim() || "an order";
  const window = ev.tier === "12h" ? "in about 12 hours" : "in two days";
  const amount = formatMoney(
    ev.amountCents != null ? ev.amountCents / 100 : null,
    ev.currency,
  );
  const stake = amount ? ` ${amount} is at stake.` : "";
  return {
    type: "return_opened",
    title: `eBay deadline ${window}`,
    message: `The ${label} on ${order} still needs your answer.${stake} ` +
      "If the clock runs out, eBay decides it without you.",
    link: POST_SALE_LINK,
  };
}

export interface CancellationRequestedEvent {
  userId: string;
  cancelId: string;
  orderLabel: string | null;
  reason: string | null;
}

export function buildCancellationRequested(ev: CancellationRequestedEvent): NotifyInput {
  const order = ev.orderLabel?.trim() || "an order";
  // eBay reasons arrive SCREAMING_SNAKE (BUYER_CANCEL_ORDER, ORDER_UNPAID). The
  // post-sale page already spells them out with the same replace; doing it here
  // too keeps the notification from being the one place that shows the raw
  // token.
  const reason = ev.reason?.trim().replace(/_/g, " ").toLowerCase();
  return {
    type: "cancellation_requested",
    title: "Cancellation requested",
    message: reason
      ? `A buyer asked to cancel ${order} (${reason}). Approve or reject it before eBay decides for you.`
      : `A buyer asked to cancel ${order}. Approve or reject it before eBay decides for you.`,
    link: POST_SALE_LINK,
  };
}

export interface DisputeOpenedEvent {
  userId: string;
  disputeId: string;
  orderLabel: string | null;
  reason: string | null;
  amount: number | null;
  currency: string | null;
  respondByDate: string | null;
}

export function buildDisputeOpened(ev: DisputeOpenedEvent): NotifyInput {
  const order = ev.orderLabel?.trim() || "an order";
  const amount = formatMoney(ev.amount, ev.currency);
  const amountPhrase = amount ? ` for ${amount}` : "";
  const deadline = ev.respondByDate
    ? ` Respond by ${ev.respondByDate.slice(0, 10)} or eBay decides against you.`
    : "";
  return {
    type: "dispute_opened",
    title: "Payment dispute opened",
    message: `A buyer opened a payment dispute${amountPhrase} on ${order}.${deadline}`,
    link: POST_SALE_LINK,
  };
}

// ── Public emitters (deliver across channels) ───────────────────────

export function notifyOfferReceived(
  ev: OfferReceivedEvent,
  deps: MarketplaceNotifyDeps = defaultDeps,
): Promise<void> {
  return deliver(ev.userId, {
    inApp: buildOfferReceived(ev),
    email: (to, userName) =>
      sendOfferReceivedEmail(to, {
        userName,
        itemTitle: ev.itemTitle?.trim() || "your listing",
        amountLabel: formatMoney(ev.price, ev.currency),
        buyerLabel: ev.buyerUsername?.trim() || null,
        expiresAt: ev.expiresAt,
      }),
    push: (userId) => pushOfferReceived(userId, ev.itemTitle),
  }, deps);
}

export function notifyOfferResponded(
  userId: string,
  itemTitle: string | null,
  action: OfferAction,
  deps: MarketplaceNotifyDeps = defaultDeps,
): Promise<void> {
  return deliver(userId, {
    inApp: buildOfferResponded(itemTitle, action),
    email: (to, userName) =>
      sendOfferRespondedEmail(to, {
        userName,
        itemTitle: itemTitle?.trim() || "your listing",
        action,
      }),
    push: (uid) => pushOfferResponded(uid, action, itemTitle),
  }, deps);
}

export function notifyReturnOpened(
  ev: ReturnOpenedEvent,
  deps: MarketplaceNotifyDeps = defaultDeps,
): Promise<void> {
  return deliver(ev.userId, {
    inApp: buildReturnOpened(ev),
    email: (to, userName) =>
      sendReturnOpenedEmail(to, {
        userName,
        itemLabel: ev.itemLabel?.trim() || "an order",
        reason: ev.reason,
      }),
    push: (userId) => pushReturnOpened(userId, ev.itemLabel),
  }, deps);
}

export function notifyInquiryOpened(
  ev: InquiryOpenedEvent,
  deps: MarketplaceNotifyDeps = defaultDeps,
): Promise<void> {
  return deliver(ev.userId, {
    inApp: buildInquiryOpened(ev),
    email: (to, userName) =>
      sendInquiryOpenedEmail(to, {
        userName,
        orderLabel: ev.orderLabel?.trim() || "an order",
        reason: ev.reason,
        respondBy: ev.respondBy,
      }),
    push: (userId) => pushInquiryOpened(userId, ev.orderLabel),
  }, deps);
}

export function notifyCaseOpened(
  ev: CaseOpenedEvent,
  deps: MarketplaceNotifyDeps = defaultDeps,
): Promise<void> {
  return deliver(ev.userId, {
    inApp: buildCaseOpened(ev),
    email: (to, userName) =>
      sendCaseOpenedEmail(to, {
        userName,
        orderLabel: ev.orderLabel?.trim() || "an order",
        reason: ev.reason,
        respondBy: ev.respondBy,
      }),
    push: (userId) => pushCaseOpened(userId, ev.orderLabel),
  }, deps);
}

/**
 * In-app only, deliberately.
 *
 * This is a nudge about an opportunity, not a deadline. Emailing a seller every
 * morning about items they MIGHT discount is the shape that gets a sender
 * marked as spam, and it would take the return and case notices down with it.
 */
export function notifyOfferCandidateDigest(
  ev: OfferCandidateDigestEvent,
  deps: MarketplaceNotifyDeps = defaultDeps,
): Promise<void> {
  return deps.notify(ev.userId, buildOfferCandidateDigest(ev)).catch((err) => {
    console.error(
      "[marketplace-notify] offer digest failed:",
      err instanceof Error ? err.message : err,
    );
  });
}

export function notifyCaseDeadline(
  ev: CaseDeadlineEvent,
  deps: MarketplaceNotifyDeps = defaultDeps,
): Promise<void> {
  return deliver(ev.userId, {
    inApp: buildCaseDeadline(ev),
    email: (to, userName) =>
      sendPostSaleDeadlineEmail(to, {
        userName,
        caseLabel: caseLabelFor(ev.caseType),
        orderLabel: ev.orderLabel?.trim() || "an order",
        respondBy: ev.respondBy,
        tier: ev.tier,
      }),
    push: (userId) => pushPostSaleDeadline(userId, ev.orderLabel),
  }, deps);
}

export function notifyCancellationRequested(
  ev: CancellationRequestedEvent,
  deps: MarketplaceNotifyDeps = defaultDeps,
): Promise<void> {
  return deliver(ev.userId, {
    inApp: buildCancellationRequested(ev),
    email: (to, userName) =>
      sendCancellationRequestedEmail(to, {
        userName,
        orderLabel: ev.orderLabel?.trim() || "an order",
        reason: ev.reason,
      }),
    push: (userId) => pushCancellationRequested(userId, ev.orderLabel),
  }, deps);
}

export function notifyDisputeOpened(
  ev: DisputeOpenedEvent,
  deps: MarketplaceNotifyDeps = defaultDeps,
): Promise<void> {
  return deliver(ev.userId, {
    inApp: buildDisputeOpened(ev),
    email: (to, userName) =>
      sendDisputeOpenedEmail(to, {
        userName,
        orderLabel: ev.orderLabel?.trim() || "an order",
        reason: ev.reason,
        amountLabel: formatMoney(ev.amount, ev.currency),
        respondByDate: ev.respondByDate,
      }),
    push: (userId) => pushDisputeOpened(userId, ev.orderLabel),
  }, deps);
}
